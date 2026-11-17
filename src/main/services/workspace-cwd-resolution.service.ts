import { realpathSync } from 'fs';
import { normalize, join, posix as pathPosix } from 'path';

import { sanitizeWorktreeProjectSegment } from '../../shared/lib/random-names';
import { getWorkspaceCwdIdentity, isSshWorkspace } from '../../shared/types';

import type { Project, Workspace } from '../../shared/types';

/** The error a resolution carries when no workspace matches the cwd at all. */
export const NO_MATCHING_WORKSPACE = 'No matching workspace found';

export type WorkspaceCwdResolution =
  | { workspace: Workspace; error?: undefined }
  | { workspace?: undefined; error: string };

export type WorkspaceProjectCwdResolution =
  | { project?: undefined; sourceWorkspace: Workspace; error?: undefined }
  | { project: Project; sourceWorkspace?: Workspace; error?: undefined }
  | { project?: undefined; sourceWorkspace?: undefined; error: string };

export interface WorkspaceCwdResolutionContext {
  workspaces: Workspace[];
  getProject: (projectId: string) => Project | undefined;
  komlaBasePath: string;
}

/** A workspace with the directory a cwd is compared against. */
interface WorkspaceDirectory {
  workspace: Workspace;
  directory: string;
  /** The directory is on an SSH host, so it is compared as a path there. */
  remote: boolean;
}

/**
 * A cwd as a path on this machine, resolved on disk only when a local workspace needs it, and as
 * a path on an SSH host.
 */
class ComparableCwd {
  readonly remote: string;
  private resolvedLocal: string | undefined;

  constructor(
    private readonly cwd: string,
    private readonly resolveLocal: (path: string) => string
  ) {
    this.remote = pathPosix.normalize(cwd);
  }

  get local(): string {
    this.resolvedLocal ??= this.resolveLocal(this.cwd);
    return this.resolvedLocal;
  }

  for(entry: WorkspaceDirectory): string {
    return entry.remote ? this.remote : this.local;
  }
}

class WorkspaceCwdResolutionService {
  findProjectByCwd(
    cwd: string,
    context: WorkspaceCwdResolutionContext
  ): WorkspaceProjectCwdResolution {
    const candidates = this.findCandidatesByCwd(cwd, context);
    if (candidates.length === 0) return { error: NO_MATCHING_WORKSPACE };

    const projectsById = new Map<string, Project>();
    for (const workspace of candidates) {
      if (!workspace.projectId) continue;
      const project = context.getProject(workspace.projectId);
      if (project) projectsById.set(project.id, project);
    }

    if (projectsById.size === 0) {
      const sshCandidates = candidates.filter(isSshWorkspace);
      const runningSshCandidates = sshCandidates.filter((workspace) =>
        this.hasRunningTerminal(workspace)
      );
      const sourceWorkspace =
        sshCandidates.length === 1
          ? sshCandidates[0]
          : runningSshCandidates.length === 1
            ? runningSshCandidates[0]
            : undefined;
      return sourceWorkspace
        ? { sourceWorkspace }
        : {
            error:
              sshCandidates.length > 1
                ? `Multiple SSH workspaces match cwd: ${cwd}. This workspace creation request cannot safely choose a source.`
                : NO_MATCHING_WORKSPACE,
          };
    }

    let project: Project | undefined;
    if (projectsById.size === 1) {
      project = Array.from(projectsById.values())[0];
    } else {
      const runningProjectIds = new Set(
        candidates
          .filter((workspace) => this.hasRunningTerminal(workspace))
          .map((workspace) => workspace.projectId)
          .filter((projectId): projectId is string => !!projectId && projectsById.has(projectId))
      );
      if (runningProjectIds.size !== 1) {
        return {
          error: `Multiple projects match cwd: ${cwd}. This workspace creation request cannot safely choose a project.`,
        };
      }
      project = projectsById.get(Array.from(runningProjectIds)[0]);
    }

    if (!project) return { error: NO_MATCHING_WORKSPACE };

    const projectCandidates = candidates.filter((workspace) => workspace.projectId === project.id);
    const runningProjectCandidates = projectCandidates.filter((workspace) =>
      this.hasRunningTerminal(workspace)
    );
    const sourceWorkspace =
      projectCandidates.length === 1
        ? projectCandidates[0]
        : runningProjectCandidates.length === 1
          ? runningProjectCandidates[0]
          : undefined;

    return { project, sourceWorkspace };
  }

  findCandidatesByCwd(cwd: string, context: WorkspaceCwdResolutionContext): Workspace[] {
    const comparableCwd = this.comparableCwd(cwd);
    const directories = this.workspaceDirectories(context.workspaces);

    const exactMatches = this.findExactMatches(comparableCwd, directories);
    if (exactMatches.length > 0) return exactMatches;

    const bestMatches = this.findDeepestDirectoryMatches(comparableCwd, directories);
    if (bestMatches.length > 0) return bestMatches;

    const fallback = this.findWorktreePathMatch(comparableCwd, context);
    return fallback ? [fallback] : [];
  }

  resolveWorkspaceByCwd(
    cwd: string,
    context: WorkspaceCwdResolutionContext,
    options: { rejectAmbiguousMatches?: boolean } = {}
  ): WorkspaceCwdResolution {
    const comparableCwd = this.comparableCwd(cwd);
    const directories = this.workspaceDirectories(context.workspaces);

    const exactMatches = this.findExactMatches(comparableCwd, directories);
    let matchingWorkspace: Workspace | undefined = exactMatches[0];
    if (options.rejectAmbiguousMatches && exactMatches.length > 0) {
      const resolution = this.resolveObviousWorkspaceMatch(cwd, exactMatches);
      if (!resolution.workspace || exactMatches.length > 1) return resolution;
    }

    if (!matchingWorkspace) {
      const bestMatches = this.findDeepestDirectoryMatches(comparableCwd, directories);

      if (options.rejectAmbiguousMatches && bestMatches.length > 0) {
        const resolution = this.resolveObviousWorkspaceMatch(cwd, bestMatches);
        if (!resolution.workspace || bestMatches.length > 1) return resolution;
      }
      matchingWorkspace = bestMatches[0];
    }

    if (!matchingWorkspace) {
      matchingWorkspace = this.findWorktreePathMatch(comparableCwd, context);
    }

    return matchingWorkspace ? { workspace: matchingWorkspace } : { error: NO_MATCHING_WORKSPACE };
  }

  private comparableCwd(cwd: string): ComparableCwd {
    return new ComparableCwd(cwd, (path) => this.normalizeForComparison(path));
  }

  /**
   * The directories of the workspaces a cwd may belong to, each resolved once per lookup. Trashed
   * workspaces run nothing, and their directory may be a new workspace's.
   */
  private workspaceDirectories(workspaces: Workspace[]): WorkspaceDirectory[] {
    return workspaces
      .filter((workspace) => workspace.status !== 'trashed')
      .map((workspace) => {
        // An SSH workspace's directory is on its host. Resolving it on this machine's disk finds
        // nothing, and on macOS a path under /home waits on the automounter for each workspace.
        const remote = isSshWorkspace(workspace);
        const directory = getWorkspaceCwdIdentity(workspace);
        return {
          workspace,
          directory: remote
            ? pathPosix.normalize(directory)
            : this.normalizeForComparison(directory),
          remote,
        };
      });
  }

  private findExactMatches(cwd: ComparableCwd, directories: WorkspaceDirectory[]): Workspace[] {
    return directories
      .filter((entry) => cwd.for(entry) === entry.directory)
      .map((entry) => entry.workspace);
  }

  private findDeepestDirectoryMatches(
    cwd: ComparableCwd,
    directories: WorkspaceDirectory[]
  ): Workspace[] {
    let bestMatches: Workspace[] = [];
    let bestLength = -1;

    for (const entry of directories) {
      const { workspace, directory: normalizedWorkspaceDir } = entry;
      const normalizedCwd = cwd.for(entry);
      const isWithinWorkspace =
        normalizedCwd === normalizedWorkspaceDir ||
        normalizedCwd.startsWith(`${normalizedWorkspaceDir}/`) ||
        normalizedCwd.startsWith(`${normalizedWorkspaceDir}\\`);

      if (isWithinWorkspace && normalizedWorkspaceDir.length > bestLength) {
        bestMatches = [workspace];
        bestLength = normalizedWorkspaceDir.length;
      } else if (isWithinWorkspace && normalizedWorkspaceDir.length === bestLength) {
        bestMatches.push(workspace);
      }
    }

    return bestMatches;
  }

  /** A local worktree workspace whose managed worktree path holds the cwd, e.g. after it moved. */
  private findWorktreePathMatch(
    cwd: ComparableCwd,
    context: WorkspaceCwdResolutionContext
  ): Workspace | undefined {
    const worktrees = context.workspaces.filter(
      (workspace): workspace is Workspace & { branchName: string } =>
        workspace.status !== 'trashed' &&
        !isSshWorkspace(workspace) &&
        !!workspace.isWorktree &&
        !!workspace.branchName
    );
    // Without one, a cwd from an SSH host isn't resolved on this machine's disk.
    if (worktrees.length === 0) return undefined;

    const normalizedCwd = cwd.local;
    const worktreesBase = this.normalizeForComparison(join(context.komlaBasePath, 'worktrees'));

    if (!normalizedCwd.startsWith(worktreesBase)) return undefined;

    const relativePath = normalizedCwd.slice(worktreesBase.length + 1);
    const segments = relativePath.split(/[/\\]/);

    if (segments.length < 2) return undefined;

    const projectName = segments[0];
    const safeBranchName = segments[1];

    return worktrees.find((workspace) => {
      const workspaceSafeBranch = workspace.branchName.replace(/\//g, '-');
      const workspaceProjectName = workspace.repoName;
      const projectMatches =
        workspaceProjectName !== undefined &&
        (workspaceProjectName === projectName ||
          sanitizeWorktreeProjectSegment(workspaceProjectName) === projectName);

      return projectMatches && workspaceSafeBranch === safeBranchName;
    });
  }

  private hasRunningTerminal(workspace: Workspace): boolean {
    if (workspace.status !== 'active') return false;
    return workspace.terminals.some(
      (terminal) => terminal.status === 'running' || terminal.status === 'starting'
    );
  }

  private resolveObviousWorkspaceMatch(
    cwd: string,
    candidates: Workspace[]
  ): WorkspaceCwdResolution {
    if (candidates.length === 0) return { error: NO_MATCHING_WORKSPACE };
    if (candidates.length === 1) return { workspace: candidates[0] };

    const runningMatches = candidates.filter((workspace) => this.hasRunningTerminal(workspace));
    if (runningMatches.length === 1) return { workspace: runningMatches[0] };

    return {
      error: `Multiple workspaces match cwd: ${cwd}. This MCP tool cannot safely choose a workspace unless exactly one matching workspace is running.`,
    };
  }

  private normalizeForComparison(pathValue: string): string {
    const normalizedPath = normalize(pathValue);

    try {
      return normalize(realpathSync.native?.(normalizedPath) ?? realpathSync(normalizedPath));
    } catch {
      return normalizedPath;
    }
  }
}

export const workspaceCwdResolutionService = new WorkspaceCwdResolutionService();

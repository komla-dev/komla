import { projectRepoPath } from '../../shared/lib/project-repo-path';
import { isMonitored } from '../../shared/lib/terminal-execution-state';
import { isSshWorkspace, type Workspace } from '../../shared/types/workspace';
import { createLogger } from '../lib/logger';
import { samePathKey } from '../lib/same-path';
import { needsSshPrompt } from '../lib/ssh-client';

import { configService } from './config.service';
import { RECENT_ORIGIN_FETCH_MS } from './git/git-branch';
import { gitService } from './git.service';
import { projectService } from './project.service';
import { remoteWorkspaceObservationService } from './remote-workspace-observation.service';
import { isSshHostDisconnected } from './ssh-host-disconnection';
import { isSshConnectionFailure, sshHostStatusService } from './ssh-host-status.service';
import { sshWorkspaceService } from './ssh-workspace.service';
import { sshWorkspaceGit } from './workspace-git/ssh-git';
import { workspaceGitService } from './workspace-git.service';
import { workspaceStatusService } from './workspace-status.service';
import { workspaceService } from './workspace.service';

import type { OriginTips } from './git/origin-tips';
import type { Project } from '../../shared/types/project';

const logger = createLogger('GitBackgroundFetch');

/**
 * How long a repository's fetch stays fresh enough to skip: half as long as a fetch lets new
 * workspaces start without fetching, so the fetch the New Workspace dialog asks for as it opens
 * still counts once the prompt is typed.
 */
export const BACKGROUND_FETCH_INTERVAL_MS = RECENT_ORIGIN_FETCH_MS / 2;
/**
 * How often a repository's fetch brings every branch of origin, so lists of origin's branches
 * and pruning catch up. The fetches between bring just the branches Komla uses.
 */
export const EVERY_BRANCH_FETCH_INTERVAL_MS = 60 * 60_000;
const FETCH_TIMEOUT_MS = 20_000;

const sshCloneKey = (hostId: string, repoPath: string): string => `ssh:${hostId}:${repoPath}`;

/**
 * A repository or host clone with copies of the same origin branches, and how to fetch it until
 * its copies are where `wanted` says.
 */
type Counterpart = { key: string; fetch: (wanted: OriginTips) => void };

/** A claimed fetch: whether it brings every branch, and how to give it back unfinished. */
type FetchClaim = { everyBranch: boolean; release: () => void };

// Git's rules for a branch name (`git check-ref-format --branch`), so a target typed with a
// space, or a base like `HEAD~1`, can't make the whole fetch fail.
function isBranchName(name: string): boolean {
  return (
    !/\p{Cc}|[\s~^:?*[\\]|\.\.|@\{|\/\/|^[-./]|[./]$|\/\.|\.lock(?:\/|$)/u.test(name) &&
    name !== '@'
  );
}

function branchName(name: string | undefined): string | undefined {
  const branch = name
    ?.trim()
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/remotes\/origin\//, '')
    .replace(/^origin\//, '');
  return branch && branch !== 'HEAD' && isBranchName(branch) ? branch : undefined;
}

/**
 * The branches of origin a repository's workspaces use: the targets, `main` and `master`, and
 * each workspace's branch and target.
 */
export function branchesInUse(
  targets: ReadonlyArray<string | undefined>,
  workspaces: readonly Workspace[]
): string[] {
  const names = [
    ...targets,
    'main',
    'master',
    ...workspaces.flatMap((workspace) => [
      workspace.branchName,
      workspace.baseBranch,
      ...(isSshWorkspace(workspace)
        ? [workspace.backend.baseBranch, workspace.backend.defaultBranch]
        : []),
    ]),
  ].map(branchName);
  return [...new Set(names.filter((name): name is string => !!name))].sort();
}

/**
 * The branches whose copy from origin Komla keeps the same on this computer and on SSH hosts:
 * the projects' targets, `main` and `master`, and each of their workspaces' targets.
 */
export function syncedBranches(projects: readonly Project[], workspaces: readonly Workspace[]) {
  const projectIds = new Set(projects.map((project) => project.id));
  return branchesInUse(
    projects.map((project) => project.baseBranch),
    workspaces
      .filter((workspace) => workspace.projectId !== null && projectIds.has(workspace.projectId))
      .map((workspace) => ({ ...workspace, branchName: '' }))
  );
}

/**
 * Whether `other` has a copy of a branch in `news` at another commit than `news` does. A branch
 * either side has no copy of doesn't count: a clone that doesn't prune or track it never would.
 */
function differs(news: OriginTips, other: OriginTips | undefined): boolean {
  return [...news].some(([branch, commit]) => {
    const otherCommit = other?.get(branch);
    return !!commit && !!otherCommit && otherCommit !== commit;
  });
}

function restore(times: Map<string, number>, key: string, at: number | undefined): void {
  if (at === undefined) times.delete(key);
  else times.set(key, at);
}

/**
 * Fetches origin for the projects that have workspaces, so their commits behind (↓N) counts
 * include what was pushed elsewhere, and a new workspace can start from a recent copy of its
 * target branch without fetching first. A fetch brings just the branches Komla uses, and every
 * branch once an hour, so a large repository isn't fetched whole every few minutes. SSH hosts
 * fetch their own clones, and only once Komla has reached them. When origin's copy of a target
 * branch moves here, as after a push, hosts whose copy is somewhere else fetch at once; when a
 * host's fetch finds it somewhere else than here, this computer fetches at once, so both agree. Git and ssh never prompt: a remote that needs a
 * password or passphrase is skipped, even one whose passphrase Komla remembers. An SSH agent that
 * confirms each use still asks.
 */
class GitBackgroundFetchService {
  private lastFetchAt = new Map<string, number>();
  private lastEveryBranchFetchAt = new Map<string, number>();
  // The fetch running in each repository or host clone; another waits for it rather than racing
  // it for the same refs, then fetches only what that one didn't.
  private fetching = new Map<string, Promise<boolean>>();
  private running: Promise<void> | null = null;
  private pending: { local: boolean; ssh: boolean } = { local: false, ssh: false };
  // Where origin's copies of the synced branches were, as each repository or host clone last
  // said: when one side learns of a move, the other fetches if its copy is elsewhere.
  private originTips = new Map<string, OriginTips>();
  // The latest read of each local repository's copies, by number.
  private tipReads = new Map<string, number>();

  /**
   * Fetches each repository not fetched in the last few minutes: local ones one at a time,
   * alongside SSH ones one at a time.
   */
  fetchStale(): Promise<void> {
    return this.request({ local: true, ssh: true });
  }

  /**
   * Fetches one project's local repository, and its clone on `hostId` when given, unless they
   * were fetched in the last few minutes, so a workspace about to be created in it starts from a
   * recent copy of its target branch. With `everyBranch`, the local repository fetches every
   * branch, so a list of origin's branches is current. Settles once both are done, with whether
   * the local repository fetched.
   */
  async fetchProject(
    projectId: string,
    hostId: string | null = null,
    everyBranch = false
  ): Promise<boolean> {
    if (configService.get().gitBackgroundFetch === false) return false;
    const project = projectService.get(projectId);
    if (!project || project.kind === 'directory') return false;
    const [fetched] = await Promise.all([
      this.fetchLocalProject(project, everyBranch),
      hostId !== null && this.fetchProjectOnHost(project, hostId),
    ]);
    return fetched;
  }

  /** Fetches just the SSH clones, for a host that just answered. */
  fetchStaleOnSshHosts(): Promise<void> {
    return this.request({ local: false, ssh: true });
  }

  // A request during a run runs once more afterwards, so a host that answers mid-run is fetched.
  private request(scope: { local: boolean; ssh: boolean }): Promise<void> {
    if (configService.get().gitBackgroundFetch === false) return Promise.resolve();
    this.pending = { local: this.pending.local || scope.local, ssh: this.pending.ssh || scope.ssh };
    this.running ??= (async () => {
      while (this.pending.local || this.pending.ssh) {
        const { local, ssh } = this.pending;
        this.pending = { local: false, ssh: false };
        await Promise.all([local && this.fetchLocal(), ssh && this.fetchSsh()]);
      }
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  // `fetch` hears whether the fetch it waited for fetched.
  private async oneAtATime(
    key: string,
    fetch: (waitedForFetch: boolean) => Promise<boolean>
  ): Promise<boolean> {
    const running = this.fetching.get(key);
    const next = (running ?? Promise.resolve(false)).then(fetch, () => fetch(false));
    this.fetching.set(key, next);
    try {
      return await next;
    } finally {
      if (this.fetching.get(key) === next) this.fetching.delete(key);
    }
  }

  // A forced claim fetches however recently the last fetch ran.
  private claim(key: string, everyBranchAsked = false, force = false): FetchClaim | undefined {
    const now = Date.now();
    const lastFetchAt = this.lastFetchAt.get(key);
    const lastEveryBranchAt = this.lastEveryBranchFetchAt.get(key);
    const since = (at: number | undefined) => (at === undefined ? Infinity : now - at);
    if (
      !force &&
      since(everyBranchAsked ? lastEveryBranchAt : lastFetchAt) < BACKGROUND_FETCH_INTERVAL_MS
    ) {
      return undefined;
    }
    const everyBranch =
      everyBranchAsked || since(lastEveryBranchAt) >= EVERY_BRANCH_FETCH_INTERVAL_MS;
    this.lastFetchAt.set(key, now);
    if (everyBranch) this.lastEveryBranchFetchAt.set(key, now);
    return {
      everyBranch,
      release: () => {
        restore(this.lastFetchAt, key, lastFetchAt);
        if (everyBranch) restore(this.lastEveryBranchFetchAt, key, lastEveryBranchAt);
      },
    };
  }

  private async fetchLocal(): Promise<void> {
    const projectIds = new Set(
      workspaceService
        .list()
        .filter((workspace) => !isSshWorkspace(workspace))
        .map((workspace) => workspace.projectId)
    );
    for (const project of projectService.list()) {
      if (project.kind === 'directory' || !projectIds.has(project.id)) continue;
      await this.fetchLocalProject(project);
    }
  }

  // With `wanted`, where an SSH host saw origin's branches: it fetches however recently the last
  // fetch ran, unless the repository's copies are there by the time its turn comes.
  private async fetchLocalProject(
    project: Project,
    everyBranchAsked = false,
    wanted?: OriginTips
  ): Promise<boolean> {
    const repoPath = projectRepoPath(project);
    const fetched = await this.fetchLocalRepository(project, repoPath, everyBranchAsked, wanted);
    if (fetched) this.reportLocalTips(repoPath);
    return fetched;
  }

  private fetchLocalRepository(
    project: Project,
    repoPath: string,
    everyBranchAsked: boolean,
    wanted: OriginTips | undefined
  ): Promise<boolean> {
    const key = samePathKey(repoPath);
    const managed = Boolean(project.managed && project.managedRepoPath);
    // Taken as it's asked for, so a workspace created while this waits behind another fetch,
    // or while it runs, stops it.
    const mark = gitService.backgroundMark(repoPath);
    return this.oneAtATime(key, async (waitedForFetch) => {
      if (gitService.backgroundMark(repoPath) !== mark) return false;
      if (wanted) {
        const tips = await gitService.originTips(repoPath, [...wanted.keys()]).catch(() => null);
        if (tips && !differs(wanted, tips)) return true;
      }
      const claim = this.claim(key, everyBranchAsked, wanted !== undefined);
      // The fetch this waited for may have just brought what it asks for.
      if (!claim) return waitedForFetch;
      try {
        if (!(await gitService.hasRemote(repoPath, 'origin'))) return false;
        const branches = claim.everyBranch
          ? undefined
          : [
              ...new Set([
                ...(await this.localBranchesInUse(repoPath)),
                ...syncedBranches(this.projectsInRepository(repoPath), workspaceService.list()),
              ]),
            ].sort();
        await gitService.fetchOriginWithoutPrompts(
          repoPath,
          managed,
          FETCH_TIMEOUT_MS,
          mark,
          branches
        );
      } catch (error) {
        // A fetch a workspace creation stopped didn't finish, so the next request tries again.
        if (gitService.backgroundMark(repoPath) !== mark) claim.release();
        logger.debug('Background fetch skipped', {
          projectId: project.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
      // Only in Komla's own clone: a user's branches move when they ask. A workspace creation
      // stops background work; leave its start point alone.
      if (managed) {
        await workspaceGitService
          .fastForwardProjectTargets(project.id, () => gitService.backgroundMark(repoPath) === mark)
          .catch((error: unknown) => {
            logger.debug('Fast-forwarding targets after a background fetch failed', {
              projectId: project.id,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }
      return true;
    });
  }

  private projectsInRepository(repoPath: string): Project[] {
    const key = samePathKey(repoPath);
    return projectService
      .list()
      .filter(
        (project) => project.kind !== 'directory' && samePathKey(projectRepoPath(project)) === key
      );
  }

  // Every project in the repository counts: two projects can share one. One without a target
  // follows the repository's main branch.
  private async localBranchesInUse(repoPath: string): Promise<string[]> {
    const projects = this.projectsInRepository(repoPath);
    const projectIds = new Set(projects.map((project) => project.id));
    const targets: Array<string | undefined> = projects.map((project) => project.baseBranch);
    if (projects.some((project) => !project.baseBranch?.trim())) {
      targets.push(await gitService.getMainBranch(repoPath).catch(() => undefined));
    }
    return branchesInUse(
      targets,
      workspaceService
        .list()
        .filter(
          (workspace) =>
            !isSshWorkspace(workspace) &&
            workspace.projectId !== null &&
            projectIds.has(workspace.projectId)
        )
    );
  }

  // The clone a new workspace clones into, once Komla knows the host's base path. Neither looking
  // it up nor the fetch connects or prompts; creation fetches what it still needs.
  private async fetchProjectOnHost(project: Project, hostId: string): Promise<void> {
    if (sshHostStatusService.get(hostId)?.state !== 'connected') return;
    try {
      const basePath = sshWorkspaceService.knownWorkspaceBasePath(hostId);
      if (basePath === undefined) return;
      const repoPath = sshWorkspaceService.managedRepoPath(basePath, project.name);
      await this.fetchSshClone(
        hostId,
        repoPath,
        workspaceService
          .list()
          .filter(
            (workspace) =>
              isSshWorkspace(workspace) &&
              workspace.backend.hostId === hostId &&
              workspace.backend.remoteRepoPath === repoPath
          ),
        project
      );
    } catch (error) {
      logger.debug('Background fetch skipped', {
        projectId: project.id,
        hostId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async fetchSsh(): Promise<void> {
    const gitProjectIds = new Set<string | null>(
      projectService
        .list()
        .filter((project) => project.kind !== 'directory')
        .map((project) => project.id)
    );
    // Workspaces on a host share its clone, so each clone is fetched once.
    const clones = new Map<string, { hostId: string; repoPath: string; workspaces: Workspace[] }>();
    for (const workspace of workspaceService.list()) {
      if (!isSshWorkspace(workspace) || !gitProjectIds.has(workspace.projectId)) continue;
      const { hostId, remoteRepoPath } = workspace.backend;
      if (sshHostStatusService.get(hostId)?.state !== 'connected') continue;
      if (isSshHostDisconnected(hostId)) continue;
      const key = sshCloneKey(hostId, remoteRepoPath);
      const clone = clones.get(key) ?? { hostId, repoPath: remoteRepoPath, workspaces: [] };
      clone.workspaces.push(workspace);
      clones.set(key, clone);
    }
    for (const { hostId, repoPath, workspaces } of clones.values()) {
      await this.fetchSshClone(hostId, repoPath, workspaces);
    }
  }

  // `project` is the one a new workspace is about to start in, which may have none there yet. With
  // `wanted`, where this computer saw origin's branches: it fetches however recently the last
  // fetch ran, unless the fetch it waited for brought them, so it doesn't hold the clone's setup
  // lock from a workspace being created for nothing.
  private fetchSshClone(
    hostId: string,
    repoPath: string,
    workspaces: Workspace[],
    project?: Project,
    wanted?: OriginTips
  ): Promise<boolean> {
    const key = sshCloneKey(hostId, repoPath);
    return this.oneAtATime(key, async (waitedForFetch) => {
      if (wanted && !differs(wanted, this.originTips.get(key))) return true;
      const claim = this.claim(key, false, wanted !== undefined);
      if (!claim) return waitedForFetch;
      const projects = [
        ...new Set([
          ...(project ? [project] : []),
          ...workspaces.flatMap((workspace) => {
            const owner = workspace.projectId ? projectService.get(workspace.projectId) : undefined;
            return owner ? [owner] : [];
          }),
        ]),
      ];
      // The branches this computer follows too, such as a main branch it found for the project.
      const synced = [
        ...new Set([
          ...syncedBranches(projects, workspaceService.list()),
          ...this.localCounterparts(projects).flatMap(({ key: local }) => [
            ...(this.originTips.get(local)?.keys() ?? []),
          ]),
        ]),
      ].sort();
      const branches = [
        ...new Set([
          ...branchesInUse(
            projects.map((owner) => owner.baseBranch),
            workspaces
          ),
          ...synced,
        ]),
      ].sort();
      try {
        const { moved, tips } = await sshWorkspaceGit.fetchOriginWithoutPrompts(
          hostId,
          repoPath,
          FETCH_TIMEOUT_MS,
          claim.everyBranch ? undefined : branches,
          synced
        );
        if (moved) await this.refreshAfterFetch(hostId, workspaces);
        if (tips) this.reportedTips(key, tips, this.localCounterparts(projects));
        // A forced fetch that didn't run, as while a workspace is set up in the clone, leaves the
        // next regular fetch due.
        else if (wanted) claim.release();
        return true;
      } catch (error) {
        // A host that dropped mid-fetch fetches again as soon as it answers, as does a forced
        // fetch that failed.
        if (wanted || (isSshConnectionFailure(error) && !needsSshPrompt(error))) claim.release();
        logger.debug('Background fetch skipped', {
          hostId,
          repoPath,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    });
  }

  /**
   * Called when a workspace's watcher saw origin's refs change in its repository, as after a
   * push, so SSH hosts whose copy is elsewhere fetch.
   */
  originRefsMovedLocally(workspaceIds: readonly string[]): void {
    const ids = new Set(workspaceIds);
    const repoPaths = new Map<string, string>();
    for (const workspace of workspaceService.list()) {
      if (!ids.has(workspace.id) || isSshWorkspace(workspace) || !workspace.projectId) continue;
      const project = projectService.get(workspace.projectId);
      if (!project || project.kind === 'directory') continue;
      const repoPath = projectRepoPath(project);
      repoPaths.set(samePathKey(repoPath), repoPath);
    }
    for (const repoPath of repoPaths.values()) this.reportLocalTips(repoPath);
  }

  // Only the newest of overlapping reads counts, so one that finishes late can't undo a move.
  private reportLocalTips(repoPath: string): void {
    if (configService.get().gitBackgroundFetch === false) return;
    const key = samePathKey(repoPath);
    const read = (this.tipReads.get(key) ?? 0) + 1;
    this.tipReads.set(key, read);
    const projects = this.projectsInRepository(repoPath);
    void this.syncedLocalBranches(repoPath, projects)
      .then((branches) => gitService.originTips(repoPath, branches))
      .then((tips) => {
        if (this.tipReads.get(key) === read) {
          this.reportedTips(key, tips, this.sshCounterparts(projects));
        }
      })
      .catch((error: unknown) => {
        logger.debug('Reading origin refs failed', {
          repoPath,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  // A project without a target follows the repository's main branch, as its fetch does.
  private async syncedLocalBranches(repoPath: string, projects: Project[]): Promise<string[]> {
    const synced = syncedBranches(projects, workspaceService.list());
    if (projects.every((project) => project.baseBranch?.trim())) return synced;
    const main = branchName(await gitService.getMainBranch(repoPath).catch(() => undefined));
    return main && !synced.includes(main) ? [...synced, main].sort() : synced;
  }

  /**
   * Records where a repository or host clone has origin's branches. When that's news, each
   * counterpart known to have a copy at another commit fetches, and reports back in turn, which
   * stops once the copies agree.
   */
  private reportedTips(key: string, tips: OriginTips, counterparts: Counterpart[]): void {
    const previous = this.originTips.get(key);
    this.originTips.set(key, new Map([...(previous ?? []), ...tips]));
    const news = new Map([...tips].filter(([branch, commit]) => previous?.get(branch) !== commit));
    if (news.size === 0 || configService.get().gitBackgroundFetch === false) return;
    for (const counterpart of counterparts) {
      if (differs(news, this.originTips.get(counterpart.key))) counterpart.fetch(news);
    }
  }

  // The host clones of the projects' SSH workspaces, on hosts Komla is connected to.
  private sshCounterparts(projects: readonly Project[]): Counterpart[] {
    const projectIds = new Set(projects.map((project) => project.id));
    const clones = new Map<string, { hostId: string; repoPath: string; workspaces: Workspace[] }>();
    for (const workspace of workspaceService.list()) {
      if (!isSshWorkspace(workspace) || !workspace.projectId) continue;
      if (!projectIds.has(workspace.projectId)) continue;
      const { hostId, remoteRepoPath } = workspace.backend;
      if (sshHostStatusService.get(hostId)?.state !== 'connected') continue;
      if (isSshHostDisconnected(hostId)) continue;
      const key = sshCloneKey(hostId, remoteRepoPath);
      const clone = clones.get(key) ?? { hostId, repoPath: remoteRepoPath, workspaces: [] };
      clone.workspaces.push(workspace);
      clones.set(key, clone);
    }
    return [...clones].map(([key, { hostId, repoPath, workspaces }]) => ({
      key,
      fetch: (wanted) => void this.fetchSshClone(hostId, repoPath, workspaces, undefined, wanted),
    }));
  }

  // The local repositories of the projects that have workspaces on this computer.
  private localCounterparts(projects: readonly Project[]): Counterpart[] {
    const local = new Set(
      workspaceService
        .list()
        .filter((workspace) => !isSshWorkspace(workspace))
        .map((workspace) => workspace.projectId)
    );
    const repositories = new Map<string, Project>();
    for (const project of projects) {
      if (project.kind === 'directory' || !local.has(project.id)) continue;
      repositories.set(samePathKey(projectRepoPath(project)), project);
    }
    return [...repositories].map(([key, project]) => ({
      key,
      fetch: (wanted) => void this.fetchLocalProject(project, false, wanted),
    }));
  }

  private async refreshAfterFetch(hostId: string, workspaces: Workspace[]): Promise<void> {
    // A running Remote Companion reports the workspaces it watches when their refs move.
    const watched = !!remoteWorkspaceObservationService.companionForHost(hostId);
    await Promise.all(
      workspaces
        .filter(
          (workspace) =>
            !(watched && isMonitored(workspace)) && !workspaceService.isDeleting(workspace.id)
        )
        .map((workspace) =>
          workspaceStatusService
            .change({ kind: 'refresh-requested', workspaceId: workspace.id, reason: 'fetched' })
            .catch((error: unknown) => {
              logger.debug('Status refresh after background fetch failed', {
                workspaceId: workspace.id,
                error: error instanceof Error ? error.message : String(error),
              });
            })
        )
    );
  }
}

export const gitBackgroundFetchService = new GitBackgroundFetchService();

import { isSshWorktreeWorkspace, resolveWorkspaceTargetBranch, type Workspace } from '../types';

/**
 * Names the clone and target a worktree workspace counts its target against, so workspaces
 * sharing both can share those counts: one on an SSH host counts its host's clone, and a local
 * one its project's local clone. A local one that names no target follows the project's default
 * branch, as every such workspace of the project does.
 */
export function getGitTargetStatusScope(
  workspace: Workspace | undefined,
  targetBranch?: string
): string | undefined {
  if (!workspace) return undefined;
  const target = targetBranch || resolveWorkspaceTargetBranch(workspace);
  if (isSshWorktreeWorkspace(workspace)) {
    if (!target) return undefined;
    return JSON.stringify([
      'ssh',
      workspace.backend.hostId,
      workspace.backend.remoteRepoPath,
      target,
    ]);
  }
  if (workspace.backend?.kind === 'ssh' || !workspace.isWorktree || !workspace.projectId) {
    return undefined;
  }
  return JSON.stringify(['local', workspace.projectId, target ?? null]);
}

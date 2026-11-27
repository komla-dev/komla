import { posix as pathPosix } from 'path';

import type { SshWorkspaceBackend } from '../../shared/types/workspace';

/** The folder on an SSH host's scratch workspaces' folders are in, under its base path. */
export const SSH_SCRATCH_DIRECTORY = 'scratch';

/**
 * The host's Komla folder that holds a workspace's files, helpers and manifests: the parent of
 * `worktrees/<project>` for a worktree, or of `scratch/` for a scratch workspace's folder.
 */
export function sshWorkspaceBasePath(backend: SshWorkspaceBackend): string {
  const parent = backend.scratch ? backend.remoteDirectory : backend.remoteProjectRoot;
  return pathPosix.dirname(pathPosix.dirname(parent));
}

/** Whether `folder` is a folder directly in the scratch folder under the host's `basePath`. */
export function isRemoteScratchFolder(basePath: string, folder: string): boolean {
  const name = pathPosix.basename(folder);
  return (
    pathPosix.normalize(folder) === folder &&
    pathPosix.dirname(folder) === pathPosix.join(basePath, SSH_SCRATCH_DIRECTORY) &&
    name !== '' &&
    name !== '.' &&
    name !== '..'
  );
}

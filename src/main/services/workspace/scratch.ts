import { existsSync, mkdirSync } from 'fs';
import { dirname, join, posix, resolve } from 'path';

import { generateBranchSuffix } from '../../../shared/lib/random-names';
import { isSshWorkspace } from '../../../shared/types/workspace';
import { deleteReleasingOpenCodeLocation } from '../../lib/opencode-service';
import { removePathInChild } from '../../lib/remove-path';
import { isSamePath } from '../../lib/same-path';
import { getKomlaBasePath } from '../paths';
import { sshWorkspaceService } from '../ssh-workspace.service';

import type { CreateWorkspaceParams, SshScratchBackend, Workspace } from '../../../shared/types';

const NAME_ATTEMPTS = 20;

/** The folder that holds every Scratch workspace's folder. */
export function scratchRoot(): string {
  return join(getKomlaBasePath(), 'scratch');
}

/** A Scratch workspace makes its own folder, here or on an SSH host, so it names no folder or project. */
export function assertScratchParams(params: CreateWorkspaceParams): void {
  if (!params.scratch) return;
  if (
    params.mode !== 'directory' ||
    params.directoryPath ||
    params.projectId ||
    (params.location?.kind === 'ssh' &&
      (params.location.gitUrl !== undefined || params.location.sourceBackend !== undefined))
  ) {
    throw new Error('A scratch workspace makes its own folder, outside any project');
  }
}

export interface ScratchFolder {
  path: string;
  /** Its name, like "swift-fox". */
  suffix: string;
  /** Where it is on an SSH host, for one there. */
  backend?: SshScratchBackend;
}

/** Names to try for a new scratch folder, in turn: readable ones first, then ones made unique. */
function scratchFolderNames(): string[] {
  return Array.from({ length: NAME_ATTEMPTS }, (_, attempt) =>
    attempt < NAME_ATTEMPTS / 2 ? generateBranchSuffix() : uniqueSuffix()
  );
}

/** Makes an empty folder for a new Scratch workspace, named like "swift-fox". */
export function createScratchFolder(): ScratchFolder {
  const root = scratchRoot();
  mkdirSync(root, { recursive: true });
  for (const suffix of scratchFolderNames()) {
    const path = join(root, suffix);
    if (existsSync(path)) continue;
    try {
      // Not recursive, so a folder made meanwhile fails instead of being shared.
      mkdirSync(path);
      return { path, suffix };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new Error('Could not make a folder for the scratch workspace.');
}

function uniqueSuffix(): string {
  return `${generateBranchSuffix()}-${Date.now().toString(36)}`;
}

/** Makes an empty folder for a new Scratch workspace on an SSH host, named like "swift-fox". */
export async function createSshScratchFolder(hostId: string): Promise<ScratchFolder> {
  const backend = await sshWorkspaceService.createScratchFolder(hostId, scratchFolderNames());
  return {
    path: `ssh://${hostId}${backend.remoteDirectory}`,
    suffix: posix.basename(backend.remoteDirectory),
    backend,
  };
}

/** Whether `path` is a folder Komla made for a Scratch workspace, directly in the scratch root. */
export function isScratchFolder(path: string): boolean {
  if (!path) return false;
  const folder = resolve(path);
  return isSamePath(dirname(folder), scratchRoot()) && !isSamePath(folder, scratchRoot());
}

/**
 * Deletes a Scratch workspace's folder. Leaves any other folder alone, even one a Scratch
 * workspace somehow points at, since the user's own folders are never Komla's to delete.
 */
export async function removeScratchFolder(workspace: Workspace): Promise<void> {
  if (!workspace.scratch) return;
  if (isSshWorkspace(workspace)) {
    // A scratch workspace's backend is always a scratch folder; any other is never deleted here.
    if (workspace.backend.scratch) await sshWorkspaceService.deleteScratchFolder(workspace.backend);
    return;
  }
  await removeScratchFolderAt(workspace.workingDirectory);
}

/** Deletes a scratch folder no workspace was published with, here or on its SSH host. */
export async function removeUnpublishedScratchFolder(folder: ScratchFolder): Promise<void> {
  if (folder.backend) await sshWorkspaceService.deleteScratchFolder(folder.backend);
  else await removeScratchFolderAt(folder.path);
}

/** Deletes `folder` and everything in it, when it's a scratch folder; leaves any other alone. */
export async function removeScratchFolderAt(folder: string): Promise<void> {
  if (!isScratchFolder(folder)) return;
  // In a child process: an agent's node_modules can be big, and main answers the renderer
  // meanwhile; nor does Electron's fs there take an .asar file for a folder.
  await deleteReleasingOpenCodeLocation(folder, () => removePathInChild(folder));
}

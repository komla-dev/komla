import { join } from 'path';

import { sanitizeWorktreeProjectSegment } from '../../shared/lib/random-names';

import { getKomlaBasePath } from './paths';

/** The folder every local worktree workspace's folder goes in. */
export function worktreesBasePath(): string {
  return join(getKomlaBasePath(), 'worktrees');
}

/** The folder a project's new worktrees go in, named after the project as it is now called. */
export function projectWorktreesFolder(projectName: string): string {
  return join(worktreesBasePath(), sanitizeWorktreeProjectSegment(projectName));
}

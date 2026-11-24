import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { stat } from 'fs/promises';
import { dirname, isAbsolute, join, resolve } from 'path';

/**
 * The `info/exclude` file Git reads for `workingDir`, or null outside a checkout. In a worktree,
 * `.git` is a file naming the worktree's own gitdir, but Git reads ignore patterns only from the
 * common gitdir that gitdir's `commondir` file names.
 */
export async function resolveGitExcludePath(workingDir: string): Promise<string | null> {
  const gitPath = join(workingDir, '.git');
  if (!existsSync(gitPath)) return null;
  let stats;
  try {
    stats = await stat(gitPath);
  } catch {
    return null;
  }
  if (stats.isDirectory()) return join(gitPath, 'info', 'exclude');
  if (!stats.isFile()) return null;

  const match = readFileSync(gitPath, 'utf-8').match(/^gitdir:\s*(.+)$/m);
  if (!match) return null;
  const raw = match[1].trim();
  const gitdir = isAbsolute(raw) ? raw : join(workingDir, raw);

  let commondir = '';
  try {
    commondir = readFileSync(join(gitdir, 'commondir'), 'utf-8').trim();
  } catch (error) {
    // Only a missing commondir (a submodule's gitdir) makes the gitdir the common one.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return join(commondir ? resolve(gitdir, commondir) : gitdir, 'info', 'exclude');
}

/**
 * Add `rule` under a `header` comment to the exclude file Git reads for `workingDir`, unless it's
 * there already. Every worktree of a repository shares that file, so the read and the write are
 * synchronous: an await between them would let another caller's rule be overwritten.
 */
export async function addGitExcludeRule(
  workingDir: string,
  header: string,
  rule: string
): Promise<void> {
  const excludePath = await resolveGitExcludePath(workingDir);
  if (!excludePath) return;
  const existing = existsSync(excludePath) ? readFileSync(excludePath, 'utf-8') : '';
  if (existing.split(/\r?\n/).some((line) => line.trim() === rule)) return;
  mkdirSync(dirname(excludePath), { recursive: true });
  const prefix = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  writeFileSync(excludePath, `${existing}${prefix}${header}\n${rule}\n`, 'utf-8');
}

/**
 * Append the lines of the exclude file at `fromPath` to the one at `toPath`, skipping blank lines
 * and lines `toPath` has already, such as Git's template comments or a rule Komla added. The
 * source's own repeats stay, since the last matching rule wins, and lines compare whole, since an
 * escaped trailing space is part of a pattern. A missing `fromPath` leaves `toPath` as it is.
 */
export function mergeGitExcludeFile(fromPath: string, toPath: string): void {
  if (!existsSync(fromPath)) return;
  const existing = existsSync(toPath) ? readFileSync(toPath, 'utf-8') : '';
  const present = new Set(existing.split(/\r?\n/));
  const added = readFileSync(fromPath, 'utf-8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '' && !present.has(line));
  if (added.length === 0) return;
  mkdirSync(dirname(toPath), { recursive: true });
  const prefix = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  writeFileSync(toPath, `${existing}${prefix}${added.join('\n')}\n`, 'utf-8');
}

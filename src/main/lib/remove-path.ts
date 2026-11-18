import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import { rmSync, type RmOptions } from 'fs';
import { lstat, mkdir, readdir, rename, rm } from 'fs/promises';
import { createRequire } from 'module';
import { constants, setPriority } from 'os';
import { basename, join } from 'path';

// Electron patches fs to treat .asar archives as directories, so recursive
// removal of a tree containing one (e.g. node_modules/electron's
// default_app.asar) leaves the archive behind and fails with ENOTEMPTY.
// Remove trees that may hold project content with Electron's unpatched fs.
interface RemoveFs {
  rmSync: typeof rmSync;
  promises: { rm: typeof rm };
}

let originalFs: RemoveFs | undefined;

function getOriginalFs(): RemoveFs | undefined {
  if (!process.versions.electron) return undefined;
  originalFs ??= createRequire(import.meta.url)('original-fs') as RemoveFs;
  return originalFs;
}

export function removePath(path: string, options?: RmOptions): Promise<void> {
  const fs = getOriginalFs();
  return fs ? fs.promises.rm(path, options) : rm(path, options);
}

export function removePathSync(path: string, options?: RmOptions): void {
  const fs = getOriginalFs();
  if (fs) fs.rmSync(path, options);
  else rmSync(path, options);
}

// Electron's own asar patching is off here, as in `removePath`.
// Retries absorb a file briefly busy (EBUSY, ENOTEMPTY) while the tree is deleted.
const REMOVE_IN_CHILD_SCRIPT =
  "process.noAsar = true; require('fs').rmSync(process.argv[1], { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });";

/**
 * Removes a tree in a short-lived child process. `removePath` deletes in the main process, where
 * a big tree (`node_modules`) holds up everything else main does, such as answering the renderer,
 * for as long as the delete takes. Use this for a tree that may be large.
 */
export function removePathInChild(
  path: string,
  { lowPriority = false, timeoutMs }: { lowPriority?: boolean; timeoutMs?: number } = {}
): Promise<void> {
  // The app's NODE_OPTIONS (a --require, an --inspect port) isn't meant for this helper.
  const { NODE_OPTIONS: _nodeOptions, ...inherited } = process.env;
  return new Promise((resolve, reject) => {
    // The same binary run as plain Node, so no Node install is needed.
    const child = execFile(
      process.execPath,
      ['-e', REMOVE_IN_CHILD_SCRIPT, path],
      {
        env: { ...inherited, ELECTRON_RUN_AS_NODE: '1' },
        windowsHide: true,
        // SIGKILL: a delete that hangs may not heed SIGTERM.
        ...(timeoutMs === undefined ? {} : { timeout: timeoutMs, killSignal: 'SIGKILL' as const }),
      },
      (error, _stdout, stderr) => {
        if (!error) return resolve();
        if (error.killed && timeoutMs !== undefined) {
          return reject(
            new Error(`Deleting ${path} took longer than ${timeoutMs / 60_000} minutes`)
          );
        }
        const detail = stderr.trim();
        reject(new Error(detail ? `${error.message}\n${detail}` : error.message));
      }
    );
    // Yields the CPU to the app and the user's other work. Best effort: a delete still runs if
    // the OS refuses.
    if (lowPriority && child.pid !== undefined) {
      try {
        setPriority(child.pid, constants.priority.PRIORITY_LOW);
      } catch {
        // Runs at normal priority.
      }
    }
  });
}

/** Told of a discarded tree that couldn't be deleted. It stays for `emptyDiscardDir` to retry. */
export type DiscardFailure = (discarded: string, error: unknown) => void;

// Trees moved into a discard folder that are queued for their delete or being deleted.
const discarding = new Set<string>();
// One delete at a time: several at once would load the disk as much as the deletes this avoids.
let deletes: Promise<void> = Promise.resolve();
// A delete that hangs, such as on a stalled mount, would otherwise hold up every one after it.
const DISCARD_DELETE_TIMEOUT_MS = 10 * 60_000;

/**
 * Queues the delete of a tree already in `discarding`. Skipped once `stopped`, leaving the tree
 * for the next `emptyDiscardDir`.
 */
function queueDelete(
  discarded: string,
  onFailure?: DiscardFailure,
  stopped: () => boolean = () => false
): void {
  const step = async (): Promise<void> => {
    try {
      if (isStopped(stopped)) return;
      await removePathInChild(discarded, {
        lowPriority: true,
        timeoutMs: DISCARD_DELETE_TIMEOUT_MS,
      });
    } catch (error) {
      try {
        onFailure?.(discarded, error);
      } catch {
        // A failing report mustn't stop the deletes queued after this one.
      }
    } finally {
      discarding.delete(discarded);
    }
  };
  // `step` never rejects, so the queue goes on whatever one delete does.
  deletes = deletes.then(step);
}

/** A `stopped` that throws, such as one reading state torn down at quit, counts as stopped. */
function isStopped(stopped: () => boolean): boolean {
  try {
    return stopped();
  } catch {
    return true;
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * Removes a tree without the caller waiting on the delete, which for a big tree (`node_modules`)
 * takes seconds. It moves the tree into `discardDir`, which must be on the same volume so the
 * move is instant, and a child process at low CPU priority deletes it there, one tree at a time.
 * Resolves once nothing is left at `path`. A tree that can't be moved is deleted where it is,
 * in a child all the same.
 */
export async function discardPath(
  path: string,
  discardDir: string,
  onFailure?: DiscardFailure
): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    // ENOTDIR: a file where a folder on the way should be, so nothing is at the path.
    if (isMissing(error) || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return;
    throw error;
  }
  await mkdir(discardDir, { recursive: true });
  const discarded = join(discardDir, `${basename(path)}-${randomBytes(6).toString('hex')}`);
  // Before the move, so a sweep of the discard folder can't start a second delete of it.
  discarding.add(discarded);
  try {
    await rename(path, discarded);
  } catch (error) {
    discarding.delete(discarded);
    if (isMissing(error)) return;
    await removePathInChild(path);
    return;
  }
  queueDelete(discarded, onFailure);
}

/**
 * Queues the delete of what `discardPath` left in `discardDir`, such as trees Komla quit before
 * deleting. It doesn't wait on the deletes, so stopping is never held up by one.
 */
export async function emptyDiscardDir(
  discardDir: string,
  stopped: () => boolean = () => false,
  onFailure?: DiscardFailure
): Promise<void> {
  const names = await readdir(discardDir).catch(() => [] as string[]);
  for (const name of names) {
    if (stopped()) return;
    const discarded = join(discardDir, name);
    if (discarding.has(discarded)) continue;
    discarding.add(discarded);
    queueDelete(discarded, onFailure, stopped);
  }
  // The folder itself stays: removing it could race a `discardPath` that has just made it.
}

import { listedPaths } from '@/lib/listed-paths';
import { useFileListStore } from '@/stores/file-list.store';

import type { TerminalFileLinkContext, TerminalFileOpenTarget } from './TerminalView';

// How long an answer holds, so moving over a line again and again doesn't ask an SSH host each time.
const HOLD_MS = 10_000;
// The longest path the check takes, and the most paths at once, as the IPC does.
const MAX_PATH_LENGTH = 4096;
const MAX_PATHS_PER_CHECK = 200;
// Past this many held answers, the ones no longer held are dropped.
const MAX_HELD = 500;

// Each terminal's answers by full path, asked for or held.
const held = new Map<string, { at: number; found: Promise<boolean | null> }>();

/** Forgets every held answer. */
export function forgetTerminalPathChecks(): void {
  held.clear();
}

/** Whether the workspace's file list has a file or folder at a path in the workspace. */
function fileListHas(workingDirectory: string | undefined, filePath: string): boolean {
  const list = workingDirectory
    ? useFileListStore.getState().getFileList(workingDirectory)
    : undefined;
  const listed = listedPaths(list, true);
  if (!listed) return false;
  const path = filePath.replace(/\/+$/, '');
  return listed.has(path) || listed.has(`${path}/`);
}

/**
 * Whether each target a terminal link resolved to is there, where the terminal runs: a file that
 * isn't a symlink, or a folder. A path the check couldn't answer for counts as not there, and is
 * asked about again the next time.
 */
export async function terminalLinkTargetsExist(
  terminalId: string,
  context: TerminalFileLinkContext,
  targets: (TerminalFileOpenTarget | null)[]
): Promise<boolean[]> {
  const { workspaceId } = context;
  const check = window.api?.terminalFilesExist;
  const now = Date.now();
  if (held.size > MAX_HELD) {
    for (const [key, { at }] of held) if (now - at >= HOLD_MS) held.delete(key);
  }

  const asked: string[] = [];
  const answers = targets.map((target): Promise<boolean | null> | boolean | null => {
    if (!target || !workspaceId) return null;
    let fullPath: string;
    if (target.type === 'external') {
      fullPath = target.fullPath;
    } else {
      const root = context.workspaceRoot;
      // The check takes POSIX paths, so a workspace on a Windows drive goes by its file list.
      if (!root?.startsWith('/')) return fileListHas(context.workingDirectory, target.filePath);
      fullPath = `${root.replace(/\/+$/, '')}/${target.filePath}`;
    }
    if (!check || fullPath.length > MAX_PATH_LENGTH) return null;
    const key = `${workspaceId}\n${terminalId}\n${fullPath}`;
    const known = held.get(key);
    if (known && now - known.at < HOLD_MS) return known.found;
    if (asked.length >= MAX_PATHS_PER_CHECK) return null;

    const index = asked.push(fullPath) - 1;
    const found: Promise<boolean | null> = Promise.resolve()
      .then(() => checked)
      .then((there) => {
        const answer = there?.[index] ?? null;
        // An unanswered path is asked about again.
        if (answer === null && held.get(key)?.found === found) held.delete(key);
        return answer;
      });
    held.set(key, { at: now, found });
    return found;
  });
  const checked: Promise<(boolean | null)[] | null> =
    // A path is only asked about with a check and a workspace to ask.
    workspaceId && asked.length > 0
      ? check(workspaceId, terminalId, asked).catch(() => null)
      : Promise.resolve(null);
  const found = await Promise.all(answers.map((answer) => Promise.resolve(answer)));
  return found.map((answer) => answer === true);
}

import { create } from 'zustand';

import type {
  TerminalFileLinkContext,
  TerminalFileOpenTarget,
} from '@/components/terminal/TerminalView';

// Each workspace keeps this many files, dropping the ones printed longest ago, then the ones
// opened longest ago.
const MAX_FILES_PER_WORKSPACE = 200;

/** A file or folder a workspace's terminal printed or opened, until Komla quits. */
export interface TerminalFile {
  /** The path as the terminal printed it, a folder's ending in a separator. */
  path: string;
  lineNumber?: number;
  /** The terminal that printed or opened it, where a path outside the workspace is read. */
  terminalId: string;
  target: TerminalFileOpenTarget;
  /** The terminal's link context, which opening the file again needs. */
  context: TerminalFileLinkContext;
  /** When a terminal last printed it, when known. */
  printedAt?: number;
  /** When it was last opened from a terminal link or the files list. */
  openedAt?: number;
  /**
   * Set when a check didn't find a path outside the workspace where its terminal runs. A print
   * or open makes the entry anew, unchecked.
   */
  missing?: true;
}

export type TerminalFilePrint = Omit<TerminalFile, 'openedAt' | 'missing'>;

interface TerminalFilesState {
  /**
   * Each workspace's files in the order the terminals printed them, the latest first: by time,
   * and among files printed at the same time, as their terminal shows them, the lowest first.
   */
  byWorkspace: Record<string, TerminalFile[]>;
  /**
   * The keys of each workspace's paths a read found to be folders though printed without their
   * trailing slash, so printing or opening them again adds the folder.
   */
  foldersByWorkspace: Record<string, ReadonlySet<string>>;
  /**
   * Adds what terminals printed, newest first. A newer print of a known file moves it to that
   * print's place, with its line and terminal; an untimed one changes nothing.
   */
  notePrinted: (workspaceId: string, prints: TerminalFilePrint[]) => void;
  /** Marks a file as opened now, with the line it was opened at, leaving it in its place. */
  noteOpened: (
    workspaceId: string,
    file: Omit<TerminalFile, 'printedAt' | 'openedAt' | 'missing'>
  ) => void;
  /**
   * Records whether a check found each file there. A file printed or opened again since the check
   * started is a new entry, which keeps its own state.
   */
  noteChecked: (workspaceId: string, found: Map<TerminalFile, boolean>) => void;
  /**
   * Makes the file with this key the folder a read found it to be, as if printed with its
   * trailing slash, as an agent prints one without it: one entry with the folder printed with it,
   * at the latest print and open of either, and so too when either is printed or opened again.
   */
  noteFolder: (workspaceId: string, key: string) => void;
}

/** One entry per file: a workspace file by its path, any other by its terminal and path. */
export function terminalFileKey({
  target,
  terminalId,
}: Pick<TerminalFile, 'target' | 'terminalId'>) {
  return target.type === 'workspace'
    ? `workspace:${target.filePath}`
    : `terminal:${terminalId}:${target.fullPath}`;
}

/** A file as the folder a read found it to be, with the trailing slash a folder has, and no line. */
function asFolder<T extends Pick<TerminalFile, 'path' | 'target' | 'lineNumber'>>(file: T): T {
  const { target, lineNumber: _lineNumber, ...rest } = file;
  return {
    ...(rest as T),
    path: `${file.path}/`,
    target:
      target.type === 'workspace'
        ? { ...target, filePath: `${target.filePath}/` }
        : { ...target, fullPath: `${target.fullPath}/` },
  };
}

/** Each of the files, the folder it is when a read found it to be one. */
function withFolders<T extends Pick<TerminalFile, 'path' | 'target' | 'terminalId'>>(
  files: T[],
  folders: ReadonlySet<string> | undefined
): T[] {
  return folders
    ? files.map((file) => (folders.has(terminalFileKey(file)) ? asFolder(file) : file))
    : files;
}

/** The later of two times, either unknown. */
function later(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined ? b : b === undefined ? a : Math.max(a, b);
}

function lastSeen(file: TerminalFile): number {
  return Math.max(file.printedAt ?? 0, file.openedAt ?? 0);
}

/** The latest printed first, untimed ones last; files printed at the same time keep their order. */
function byPrintTime(a: TerminalFile, b: TerminalFile): number {
  return (b.printedAt ?? -Infinity) - (a.printedAt ?? -Infinity) || 0;
}

/**
 * The newest MAX_FILES_PER_WORKSPACE files, in their order, opened ones kept first, so a burst of
 * printed paths, most of which the list never shows, can't push them out. Untimed ones count as
 * the oldest.
 */
function capped(files: TerminalFile[]): TerminalFile[] {
  if (files.length <= MAX_FILES_PER_WORKSPACE) return files;
  const kept = new Set(
    [...files]
      .sort(
        (a, b) =>
          Number(b.openedAt !== undefined) - Number(a.openedAt !== undefined) ||
          lastSeen(b) - lastSeen(a)
      )
      .slice(0, MAX_FILES_PER_WORKSPACE)
  );
  return files.filter((file) => kept.has(file));
}

export const useTerminalFilesStore = create<TerminalFilesState>((set) => ({
  byWorkspace: {},
  foldersByWorkspace: {},

  notePrinted: (workspaceId, printed) => {
    if (printed.length === 0) return;
    set(({ byWorkspace, foldersByWorkspace }) => {
      const prints = withFolders(printed, foldersByWorkspace[workspaceId]);
      const files = byWorkspace[workspaceId] ?? [];
      const known = new Map(files.map((file) => [terminalFileKey(file), file]));
      const fresh = new Map<string, TerminalFile>();
      for (const print of prints) {
        const key = terminalFileKey(print);
        const seen = fresh.get(key) ?? known.get(key);
        if (!seen) {
          fresh.set(key, print);
        } else if (print.printedAt !== undefined && print.printedAt > (seen.printedAt ?? 0)) {
          fresh.set(key, { ...print, openedAt: known.get(key)?.openedAt });
        }
      }
      if (fresh.size === 0) return {};
      // A file read now, printed at the same time as one read before, is lower in its terminal.
      const next = [
        ...fresh.values(),
        ...files.filter((file) => !fresh.has(terminalFileKey(file))),
      ].sort(byPrintTime);
      return { byWorkspace: { ...byWorkspace, [workspaceId]: capped(next) } };
    });
  },

  noteOpened: (workspaceId, opening) => {
    set(({ byWorkspace, foldersByWorkspace }) => {
      const [file] = withFolders([opening], foldersByWorkspace[workspaceId]);
      const key = terminalFileKey(file);
      const files = byWorkspace[workspaceId] ?? [];
      const known = files.find((candidate) => terminalFileKey(candidate) === key);
      const opened: TerminalFile = {
        ...file,
        printedAt: known?.printedAt,
        openedAt: Date.now(),
      };
      // It keeps its place among the printed files; one never printed goes with the untimed.
      const next = known
        ? files.map((candidate) => (candidate === known ? opened : candidate))
        : [...files, opened];
      return { byWorkspace: { ...byWorkspace, [workspaceId]: capped(next) } };
    });
  },

  noteChecked: (workspaceId, found) => {
    set(({ byWorkspace }) => {
      const files = byWorkspace[workspaceId];
      if (!files) return {};
      let changed = false;
      const next = files.map((file) => {
        const there = found.get(file);
        if (there === undefined || there !== !!file.missing) return file;
        changed = true;
        if (!there) return { ...file, missing: true as const };
        const { missing: _missing, ...rest } = file;
        return rest;
      });
      return changed ? { byWorkspace: { ...byWorkspace, [workspaceId]: next } } : {};
    });
  },

  noteFolder: (workspaceId, key) => {
    set(({ byWorkspace, foldersByWorkspace }) => {
      const files = byWorkspace[workspaceId] ?? [];
      const file = files.find((candidate) => terminalFileKey(candidate) === key);
      const known = foldersByWorkspace[workspaceId]?.has(key);
      if (known && !file) return {};
      const remembered = known
        ? {}
        : {
            foldersByWorkspace: {
              ...foldersByWorkspace,
              [workspaceId]: new Set(foldersByWorkspace[workspaceId]).add(key),
            },
          };
      if (!file) return remembered;
      const folderKey = terminalFileKey(asFolder(file));
      const printedWithSlash = files.find((candidate) => terminalFileKey(candidate) === folderKey);
      // In the place of the one printed last, with its line and terminal, as a newer print takes.
      const replaced =
        printedWithSlash && (printedWithSlash.printedAt ?? 0) > (file.printedAt ?? 0)
          ? printedWithSlash
          : file;
      // The read found it, whatever a check said of the file it was taken for.
      const {
        missing: _missing,
        lineNumber: _lineNumber,
        ...rest
      } = replaced === file ? asFolder(file) : replaced;
      const folder: TerminalFile = {
        ...rest,
        printedAt: later(file.printedAt, printedWithSlash?.printedAt),
        openedAt: later(file.openedAt, printedWithSlash?.openedAt),
      };
      const next = files
        .filter(
          (candidate) =>
            candidate === replaced || (candidate !== file && candidate !== printedWithSlash)
        )
        .map((candidate) => (candidate === replaced ? folder : candidate));
      return {
        ...remembered,
        byWorkspace: { ...byWorkspace, [workspaceId]: next },
      };
    });
  },
}));

// Each live terminal's link context, which reading its printed paths needs.
const linkContexts = new Map<string, TerminalFileLinkContext>();
// File hyperlinks printed since the list last read the workspace's terminals, each file once, at
// its latest print, oldest first.
const queuedHyperlinks = new Map<string, Map<string, TerminalFilePrint>>();
// Files waiting per workspace, so a busy terminal can't hold on to too many.
const MAX_QUEUED_HYPERLINKS = 500;

/** Sets the link context of a terminal on screen, or forgets it when the terminal goes. */
export function setTerminalFileLinkContext(
  terminalId: string,
  context: TerminalFileLinkContext | undefined
): void {
  if (context) linkContexts.set(terminalId, context);
  else linkContexts.delete(terminalId);
}

export function terminalFileLinkContext(terminalId: string): TerminalFileLinkContext | undefined {
  return linkContexts.get(terminalId);
}

/**
 * Holds a file hyperlink a terminal printed until the list next reads the terminals. A program
 * that redraws its screen prints the same links over and over, so each file waits once.
 */
export function queuePrintedFileHyperlink(workspaceId: string, print: TerminalFilePrint): void {
  const queued = queuedHyperlinks.get(workspaceId) ?? new Map<string, TerminalFilePrint>();
  const key = terminalFileKey(print);
  queued.delete(key);
  queued.set(key, print);
  if (queued.size > MAX_QUEUED_HYPERLINKS) queued.delete(queued.keys().next().value!);
  queuedHyperlinks.set(workspaceId, queued);
}

/** The file hyperlinks printed since the last call, newest first. */
export function takeQueuedFileHyperlinks(workspaceId: string): TerminalFilePrint[] {
  const queued = queuedHyperlinks.get(workspaceId);
  queuedHyperlinks.delete(workspaceId);
  return queued ? [...queued.values()].reverse() : [];
}

import { isInLinkedWorkspaces } from '../../shared/lib/linked-workspaces';

import { listedPaths } from './listed-paths';

/** Workspace files a path that isn't there may have meant. */
export interface WorkspaceFileSuggestions {
  /**
   * The listed files that end with the most of the path's last folders and its name, the ones
   * in the fewest folders first.
   */
  paths: string[];
  /**
   * Whether they end with the whole path, as one printed from a folder inside the workspace or
   * without its folders does, and not just the name of a file that may have moved.
   */
  whole: boolean;
}

const NONE: WorkspaceFileSuggestions = { paths: [], whole: false };

/**
 * The files among `listed`, paths from the workspace root with `/` separators, that a path not
 * among them may have meant. None when the path is listed.
 */
export function suggestWorkspaceFiles(
  listed: Iterable<string>[],
  filePath: string
): WorkspaceFileSuggestions {
  const segments = filePath.split('/').filter((segment) => segment && segment !== '.');
  const name = segments.at(-1);
  if (!name) return NONE;
  const wanted = segments.join('/');
  const nameEnd = `/${name}`;

  let depth = 0;
  let paths: string[] = [];
  for (const files of listed) {
    for (const file of files) {
      if (file === wanted) return NONE;
      if (file !== name && !file.endsWith(nameEnd)) continue;
      // How many of the path's last segments the file ends with.
      const parts = file.split('/');
      let shared = 1;
      while (
        shared < segments.length &&
        shared < parts.length &&
        parts[parts.length - 1 - shared] === segments[segments.length - 1 - shared]
      ) {
        shared++;
      }
      if (shared < depth) continue;
      if (shared > depth) paths = [];
      depth = shared;
      paths.push(file);
    }
  }
  paths = [...new Set(paths)].sort(
    (a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b)
  );
  return { paths, whole: depth === segments.length };
}

/** A workspace's file list, as far as suggesting from it goes. */
interface SuggestedFromList {
  files: string[];
  gitIgnoredFiles: string[];
  emptyDirs: string[];
  isLoading: boolean;
}

/** Whether a read's error says the path isn't there, a folder on the way being a file included. */
export function isMissingFileError(message: string): boolean {
  return /^(ENOENT|ENOTDIR)\b/.test(message);
}

/**
 * The listed files a workspace path may have meant, or null when the list suggests none: the
 * list isn't loaded, or the path is listed or in a linked workspace, whose files the list of
 * this workspace leaves out.
 */
export function workspaceFileSuggestions(
  list: SuggestedFromList | undefined,
  filePath: string
): WorkspaceFileSuggestions | null {
  const listed = listedPaths(list, true);
  // Most paths asked about are listed, which a walk through the list needn't find out.
  if (!list || !listed || listed.has(filePath)) return null;
  if (isInLinkedWorkspaces(filePath)) return null;
  const suggestions = suggestWorkspaceFiles([list.files, list.gitIgnoredFiles], filePath);
  return suggestions.paths.length > 0 ? suggestions : null;
}

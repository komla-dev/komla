const NO_PATHS: string[] = [];

type FileList = {
  files: string[];
  gitIgnoredFiles: string[];
  emptyDirs: string[];
  isLoading: boolean;
};

interface ListedPathSet {
  gitIgnoredFiles: string[];
  emptyDirs: string[];
  paths: Set<string>;
}

// Each file list's paths, built the first time each is needed. Keyed by its arrays, which a list
// marked stale or fetched again with the same paths keeps, unlike the list itself. One set with
// the ignored files and one without, as the file tree and a terminal link ask for different ones.
const listedPathSets = new WeakMap<string[], { shown?: ListedPathSet; hidden?: ListedPathSet }>();

/**
 * The paths the file tree lists: its files, their folders, its empty folders and, while it shows
 * them, its ignored files, each folder ending in a slash. Null before the list loads, when any
 * path may be in it.
 */
export function listedPaths(list: FileList | undefined, showsIgnored: boolean): Set<string> | null {
  if (!list || (list.isLoading && list.files.length === 0)) return null;
  // The list can hold ignored files the tree hides: an SSH workspace's always has them.
  const gitIgnoredFiles = showsIgnored ? list.gitIgnoredFiles : NO_PATHS;
  const sets = listedPathSets.get(list.files) ?? {};
  const built = showsIgnored ? sets.shown : sets.hidden;
  if (built?.gitIgnoredFiles === gitIgnoredFiles && built.emptyDirs === list.emptyDirs) {
    return built.paths;
  }
  const paths = new Set<string>();
  for (const files of [list.files, gitIgnoredFiles]) {
    for (const file of files) {
      paths.add(file);
      for (let slash = file.indexOf('/'); slash !== -1; slash = file.indexOf('/', slash + 1)) {
        paths.add(file.slice(0, slash + 1));
      }
    }
  }
  for (const dir of list.emptyDirs) paths.add(dir.endsWith('/') ? dir : `${dir}/`);
  const set = { gitIgnoredFiles, emptyDirs: list.emptyDirs, paths };
  listedPathSets.set(list.files, showsIgnored ? { ...sets, shown: set } : { ...sets, hidden: set });
  return paths;
}

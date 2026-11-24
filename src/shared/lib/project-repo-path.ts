import type { Project } from '../types/project';

/** The local clone Komla works in: a managed project's own clone, otherwise the user's repository. */
export function projectRepoPath(
  project: Pick<Project, 'managed' | 'managedRepoPath' | 'repositoryPath'>
): string {
  return project.managed && project.managedRepoPath
    ? project.managedRepoPath
    : project.repositoryPath;
}

/**
 * The folder to show for a project: a managed project's own folder, which holds its clone, since
 * the folder it was added from may belong to another tool or be gone; otherwise the user's.
 */
export function projectFolderPath(
  project: Pick<Project, 'managed' | 'managedRepoPath' | 'repositoryPath'>
): string {
  return project.managed && project.managedRepoPath
    ? parentFolder(project.managedRepoPath)
    : project.repositoryPath;
}

// Without Node's path module, which the renderer doesn't have.
function parentFolder(path: string): string {
  return path.replace(/[\\/]+[^\\/]+[\\/]*$/, '') || path;
}

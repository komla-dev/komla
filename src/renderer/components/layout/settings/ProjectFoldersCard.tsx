import { Copy, FolderOpen } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

import { IconButton } from '@/components/ui/icon-button';
import { WrappingPath } from '@/components/ui/wrapping-path';
import { useToastStore } from '@/stores/toast.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import { SettingsCard } from './SettingsCard';
import { SettingsRow } from './SettingsRow';

import type { Project, ProjectFolders } from '@/types';

/**
 * Where a Git project's files are on this computer: Komla's clone, which keeps the name the
 * project had when added, and the folder new worktrees go in, which follows its current name.
 */
export function ProjectFoldersCard({ project }: { project: Project }) {
  // With the project they belong to, so another project's never show, even for a moment.
  const [loaded, setLoaded] = useState<{ projectId: string; folders: ProjectFolders | null }>();
  const { id: projectId, name } = project;
  // The first workspace makes the worktrees folder.
  const workspaceCount = useWorkspacesStore(
    (s) => s.workspaces.filter((workspace) => workspace.projectId === projectId).length
  );

  // Again when what they come from changes: a rename, or a new workspace.
  useEffect(() => {
    let current = true;
    window.api
      .getProjectFolders(projectId)
      .then((folders) => current && setLoaded({ projectId, folders }))
      .catch(() => current && setLoaded({ projectId, folders: null }));
    return () => {
      current = false;
    };
  }, [projectId, name, workspaceCount]);

  const folders = loaded?.projectId === projectId ? loaded.folders : null;
  if (!folders) return null;

  return (
    <SettingsCard title="Folders">
      <SettingsRow
        label={project.managed ? "Komla's clone" : 'Repository'}
        description={
          project.managed
            ? 'The repository Komla runs Git in. Workspaces are worktrees of it.'
            : 'Workspaces are worktrees of this repository.'
        }
      >
        <FolderPath path={folders.repository} />
      </SettingsRow>
      <SettingsRow
        label="Worktrees"
        description="Where new workspaces' worktrees go. Renaming the project leaves existing ones where they are."
      >
        <FolderPath path={folders.worktrees.path} canShow={folders.worktrees.exists} />
      </SettingsRow>
    </SettingsCard>
  );
}

/** A folder's path to copy, and to show in its folder once it exists. */
function FolderPath({ path, canShow = true }: { path: string; canShow?: boolean }) {
  const addToast = useToastStore((s) => s.addToast);
  return (
    <div className="flex max-w-80 items-center gap-1">
      <span className="min-w-0 font-mono text-xs">
        <WrappingPath path={path} />
      </span>
      <IconButton
        label="Copy path"
        size="xs"
        onClick={() => {
          window.api.copyToClipboard(path);
          addToast(`Copied ${path}`, 'success');
        }}
      >
        <Copy />
      </IconButton>
      {canShow && (
        <IconButton
          label="Show in folder"
          size="xs"
          onClick={() => window.api.showItemInFolder(path)}
        >
          <FolderOpen />
        </IconButton>
      )}
    </div>
  );
}

import { FolderPlus, Link } from '@phosphor-icons/react';
import React, { useState, useSyncExternalStore } from 'react';

import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Spinner } from '@/components/ui/spinner';
import { useProjectsStore } from '@/stores/projects.store';
import { useToastStore } from '@/stores/toast.store';
import {
  isSshWorktreeWorkspace,
  type Project,
  type SshWorktreeBackend,
  type Workspace,
} from '@/types';

import type { WorkspaceGroup } from './workspace-list-ordering';

type SshWorkspace = Workspace & { backend: SshWorktreeBackend };

/** The SSH workspaces in a group with no project here, e.g. ones added from another device. */
export function sshWorkspacesWithoutProject(group: WorkspaceGroup): SshWorkspace[] {
  if (group.projectId || group.isDirectory) return [];
  return group.workspaces.filter((workspace): workspace is SshWorkspace =>
    isSshWorktreeWorkspace(workspace)
  );
}

// Repositories being cloned, shared by a group's callout and its context menu.
let addingRemoteUrls: ReadonlySet<string> = new Set();
const addingListeners = new Set<() => void>();
function setAdding(remoteUrl: string, adding: boolean): void {
  const next = new Set(addingRemoteUrls);
  if (adding) next.add(remoteUrl);
  else next.delete(remoteUrl);
  addingRemoteUrls = next;
  for (const listener of addingListeners) listener();
}
function subscribeAdding(listener: () => void): () => void {
  addingListeners.add(listener);
  return () => addingListeners.delete(listener);
}

/**
 * The one git project here with the name a group's repository goes by, on the host or in its
 * URLs. Their URLs didn't match, e.g. because the repository was renamed and one side still uses
 * the old URL, so adding the repository again would make a second project named like "app-2".
 * Two projects with the name could be a fork and its upstream, so neither is suggested then.
 */
export function sameNamedProject(
  projects: readonly Project[],
  workspaces: readonly SshWorkspace[]
): Project | undefined {
  const names = new Set(
    workspaces
      .flatMap((workspace) => [
        workspace.backend.projectName,
        repositoryNameFromUrl(workspace.backend.gitUrl),
      ])
      .map((name) => name?.trim().toLowerCase())
      .filter((name): name is string => !!name)
  );
  const matches = projects.filter(
    (project) => project.kind !== 'directory' && names.has(project.name.trim().toLowerCase())
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/** The repository's own name in its URL, as adding it as a project names the project. */
function repositoryNameFromUrl(url: string): string | undefined {
  const path = url.trim().replace(/#.*$/, '').replace(/\/+$/, '');
  return /[/:]([^/:]+?)(?:\.git)?$/i.exec(path)?.[1];
}

function useAddAsProject(workspace: SshWorkspace) {
  const createProjectFromRemote = useProjectsStore((s) => s.createProjectFromRemote);
  const addToast = useToastStore((s) => s.addToast);
  const remoteUrl = workspace.backend.gitUrl;
  const adding = useSyncExternalStore(subscribeAdding, () => addingRemoteUrls.has(remoteUrl));

  const add = async () => {
    if (addingRemoteUrls.has(remoteUrl)) return;
    setAdding(remoteUrl, true);
    try {
      // Main moves this repository's SSH workspaces into the new project.
      const project = await createProjectFromRemote({ remoteUrl });
      addToast(`Added ${project.name} as a project`, 'success');
    } catch (error) {
      addToast(`Couldn’t add ${remoteUrl} as a project: ${(error as Error).message}`, 'error');
    } finally {
      setAdding(remoteUrl, false);
    }
  };

  return { adding, add };
}

function useLinkToProject(workspaces: readonly SshWorkspace[]) {
  const addToast = useToastStore((s) => s.addToast);
  const [linking, setLinking] = useState(false);
  const link = async (projectId: string, projectName: string) => {
    // A group by repository name can span hosts and clones; linking one moves its clone's.
    const clones = new Map(
      workspaces.map((workspace) => [
        `${workspace.backend.hostId}\0${workspace.backend.remoteRepoPath}`,
        workspace.id,
      ])
    );
    setLinking(true);
    try {
      for (const workspaceId of clones.values()) {
        await window.api.linkSshWorkspaceToProject(workspaceId, projectId);
      }
      addToast(`Moved to ${projectName}`, 'success');
    } catch (error) {
      addToast(`Couldn’t move to ${projectName}: ${(error as Error).message}`, 'error');
    } finally {
      setLinking(false);
    }
  };
  return { linking, link };
}

/**
 * Says under a group's header that its SSH workspaces have no project here, e.g. ones another Komla
 * installation added on the host, and offers to clone their repository so they join one, or to
 * link them to a project here with the repository's name.
 */
export function SshRepositoryNotAProjectCallout({
  workspaces,
  repoName,
  className,
}: {
  workspaces: SshWorkspace[];
  repoName: string;
  className?: string;
}) {
  const projects = useProjectsStore((s) => s.projects);
  const { adding, add } = useAddAsProject(workspaces[0]);
  const { linking, link } = useLinkToProject(workspaces);
  const match = sameNamedProject(projects, workspaces);
  return (
    <Callout
      tone="info"
      size="sm"
      icon={<FolderPlus className="size-3.5" weight="fill" />}
      className={className}
    >
      {match ? (
        <>
          <p>On an SSH host, but not in a project here. Is it your {match.name} project?</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <Button
              size="sm"
              className="h-6 gap-1.5 px-2 text-xs"
              disabled={linking || adding}
              onClick={() => void link(match.id, match.name)}
            >
              {linking ? <Spinner size="sm" /> : <Link className="size-3.5" />}
              Link to {match.name}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 gap-1.5 px-2 text-xs"
              aria-label={`Add ${repoName} as a new project`}
              disabled={adding || linking}
              onClick={() => void add()}
            >
              {adding && <Spinner size="sm" />}
              Add as new project
            </Button>
          </div>
        </>
      ) : (
        <>
          <p>On an SSH host, but not a project here yet.</p>
          <Button
            size="sm"
            className="mt-1.5 h-6 gap-1.5 px-2 text-xs"
            // The visible label leaves the repository to the header above; a screen reader needs it.
            aria-label={`Add ${repoName} as a project`}
            disabled={adding}
            onClick={() => void add()}
          >
            {adding && <Spinner size="sm" />}
            Add as project
          </Button>
        </>
      )}
    </Callout>
  );
}

export function SshRepositoryGroupContextMenu({
  workspaces,
  children,
}: {
  workspaces: SshWorkspace[];
  children: React.ReactNode;
}) {
  const projects = useProjectsStore((s) => s.projects);
  const { adding, add } = useAddAsProject(workspaces[0]);
  const { linking, link } = useLinkToProject(workspaces);
  const gitProjects = projects.filter((project) => project.kind !== 'directory');
  const match = sameNamedProject(projects, workspaces);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        {match && (
          <ContextMenuItem disabled={linking} onSelect={() => void link(match.id, match.name)}>
            <Link />
            Link to {match.name}
          </ContextMenuItem>
        )}
        <ContextMenuItem disabled={adding || linking} onSelect={() => void add()}>
          <FolderPlus />
          {match ? 'Add as new project' : 'Add as project'}
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger disabled={gitProjects.length === 0}>
            <Link />
            Link to project
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {gitProjects.map((project) => (
              <ContextMenuItem
                key={project.id}
                onSelect={() => void link(project.id, project.name)}
              >
                {project.name}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
      </ContextMenuContent>
    </ContextMenu>
  );
}

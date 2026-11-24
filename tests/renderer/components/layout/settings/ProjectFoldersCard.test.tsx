/**
 * @vitest-environment jsdom
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectFoldersCard } from '../../../../../src/renderer/components/layout/settings/ProjectFoldersCard';
import { TooltipProvider } from '../../../../../src/renderer/components/ui/tooltip';
import { useWorkspacesStore } from '../../../../../src/renderer/stores/workspaces.store';

import type { Project, ProjectFolders } from '../../../../../src/shared/types';

const mocks = vi.hoisted(() => ({ addToast: vi.fn() }));

vi.mock('../../../../../src/renderer/stores/toast.store', () => ({
  useToastStore: (selector: (state: { addToast: typeof mocks.addToast }) => unknown) =>
    selector({ addToast: mocks.addToast }),
}));

const project: Project = {
  id: 'aikm',
  kind: 'git',
  name: 'AiKM',
  repositoryPath: '/old-tool/akm',
  defaultBranchPrefix: '',
  createdAt: 0,
  order: 0,
  managed: true,
  managedRepoPath: '/home/me/.komla/repos/akm/.git',
};

const folders: ProjectFolders = {
  repository: '/home/me/.komla/repos/akm',
  worktrees: { path: '/home/me/.komla/worktrees/AiKM', exists: true },
};

function installApi(foldersOf: (projectId: string) => Promise<ProjectFolders | null>) {
  window.api = {
    getProjectFolders: vi.fn(foldersOf),
    copyToClipboard: vi.fn(),
    showItemInFolder: vi.fn(),
  } as never;
}

function renderCard() {
  const ui = (shown: Project) => (
    <TooltipProvider>
      <ProjectFoldersCard project={shown} />
    </TooltipProvider>
  );
  const { rerender } = render(ui(project));
  return { showProject: (next: Project) => rerender(ui(next)) };
}

describe('ProjectFoldersCard', () => {
  beforeEach(() => {
    mocks.addToast.mockReset();
    useWorkspacesStore.setState({ workspaces: [] });
  });

  it("shows Komla's clone and the worktrees folder, each copyable and shown in its folder", async () => {
    const user = userEvent.setup();
    installApi(async () => folders);
    renderCard();

    expect(await screen.findByText("Komla's clone")).toBeTruthy();
    expect(screen.getByText('Worktrees')).toBeTruthy();
    // Never the folder it was added from, which may be gone.
    expect(screen.queryByText(/old-tool/)).toBeNull();

    const [copyClone] = screen.getAllByRole('button', { name: 'Copy path' });
    await user.click(copyClone!);
    expect(window.api.copyToClipboard).toHaveBeenCalledWith('/home/me/.komla/repos/akm');
    const [, showWorktrees] = screen.getAllByRole('button', { name: 'Show in folder' });
    await user.click(showWorktrees!);
    expect(window.api.showItemInFolder).toHaveBeenCalledWith('/home/me/.komla/worktrees/AiKM');
  });

  it("offers to show the worktrees folder once the project's first workspace made it", async () => {
    let made = false;
    installApi(async () => ({ ...folders, worktrees: { ...folders.worktrees, exists: made } }));
    renderCard();
    await screen.findByText('Worktrees');
    expect(screen.getAllByRole('button', { name: 'Show in folder' })).toHaveLength(1);

    made = true;
    act(() =>
      useWorkspacesStore.setState({ workspaces: [{ id: 'w1', projectId: project.id } as never] })
    );

    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Show in folder' })).toHaveLength(2)
    );
  });

  it("never shows one project's folders for another while they load", async () => {
    let resolveOther: (other: ProjectFolders) => void = () => {};
    installApi((projectId) =>
      projectId === project.id
        ? Promise.resolve(folders)
        : new Promise((resolve) => (resolveOther = resolve))
    );
    const { showProject } = renderCard();
    expect(await screen.findByText("Komla's clone")).toBeTruthy();

    showProject({ ...project, id: 'other', name: 'Other' });

    expect(screen.queryByText("Komla's clone")).toBeNull();
    resolveOther({ ...folders, repository: '/home/me/.komla/repos/other' });
    expect(await screen.findByText("Komla's clone")).toBeTruthy();
    await userEvent.setup().click(screen.getAllByRole('button', { name: 'Copy path' })[0]!);
    expect(window.api.copyToClipboard).toHaveBeenCalledWith('/home/me/.komla/repos/other');
  });

  it('shows nothing for a folder project', async () => {
    installApi(async () => null);
    renderCard();
    await waitFor(() => expect(window.api.getProjectFolders).toHaveBeenCalledWith('aikm'));
    // Lets its answer render, if it rendered anything.
    await act(async () => {});
    expect(screen.queryByText('Folders')).toBeNull();
  });
});

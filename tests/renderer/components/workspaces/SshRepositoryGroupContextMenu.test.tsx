/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  SshRepositoryGroupContextMenu,
  SshRepositoryNotAProjectCallout,
  sshWorkspacesWithoutProject,
} from "../../../../src/renderer/components/workspaces/SshRepositoryGroupContextMenu";
import { useProjectsStore } from "../../../../src/renderer/stores/projects.store";
import { useToastStore } from "../../../../src/renderer/stores/toast.store";
import { createProject, createWorktreeWorkspace } from "../../../factories";

import type { Workspace } from "../../../../src/renderer/types";

vi.mock("../../../../src/renderer/components/ui/tooltip", () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipContent: () => null,
}));
// Render the context menu inline so its items are plain buttons.
vi.mock("../../../../src/renderer/components/ui/context-menu", () => ({
  ContextMenu: ({ children }: React.PropsWithChildren) => <>{children}</>,
  ContextMenuTrigger: ({ children }: React.PropsWithChildren) => (
    <>{children}</>
  ),
  ContextMenuContent: ({ children }: React.PropsWithChildren) => (
    <div role="menu">{children}</div>
  ),
  ContextMenuItem: ({
    children,
    disabled,
    onSelect,
  }: React.PropsWithChildren<{
    disabled?: boolean;
    onSelect?: () => void;
  }>) => (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onSelect}
    >
      {children}
    </button>
  ),
  ContextMenuSub: ({ children }: React.PropsWithChildren) => (
    <div>{children}</div>
  ),
  ContextMenuSubTrigger: ({ children }: React.PropsWithChildren) => (
    <span>{children}</span>
  ),
  ContextMenuSubContent: ({ children }: React.PropsWithChildren) => (
    <div>{children}</div>
  ),
}));

const backend = {
  kind: "ssh" as const,
  hostId: "ssh-dev",
  remoteDirectory: "/home/dev/.komla/worktrees/app/fix-login",
  remoteRepoPath: "/home/dev/.komla/repos/app/repo.git",
  remoteProjectRoot: "/home/dev/.komla/worktrees/app",
  gitUrl: "git@github.com:acme/app.git",
};

function sshWorkspace(overrides: Partial<Workspace> = {}) {
  const workspace = createWorktreeWorkspace({
    id: "ws-42",
    projectId: null,
    repoName: "app",
    backend,
    ...overrides,
  });
  const [found] = sshWorkspacesWithoutProject({
    key: "repo:app",
    projectId: null,
    projectInfo: { name: "app", color: "#000" },
    workspaces: [workspace],
  });
  if (!found) throw new Error("expected an SSH workspace without a project");
  return found;
}

describe("SSH repository groups", () => {
  const createProjectFromRemote = vi.fn();
  const linkSshWorkspaceToProject = vi.fn();

  beforeEach(() => {
    createProjectFromRemote.mockReset();
    linkSshWorkspaceToProject.mockReset().mockResolvedValue(undefined);
    useToastStore.setState({ toasts: [] });
    useProjectsStore.setState({
      projects: [
        createProject({ id: "project-1", name: "Komla" }),
        createProject({ id: "dir-1", name: "Notes", kind: "directory" }),
      ],
      createProjectFromRemote,
    });
    (window as unknown as { api: Record<string, unknown> }).api = {
      linkSshWorkspaceToProject,
    };
  });

  it("only offers its actions for SSH workspaces without a project", () => {
    const group = {
      key: "repo:app",
      projectId: null,
      projectInfo: { name: "app", color: "#000" },
    };
    expect(
      sshWorkspacesWithoutProject({
        ...group,
        workspaces: [createWorktreeWorkspace()],
      }),
    ).toEqual([]);
    expect(
      sshWorkspacesWithoutProject({
        ...group,
        projectId: "project-1",
        workspaces: [createWorktreeWorkspace({ backend })],
      }),
    ).toEqual([]);
  });

  it("adds the repository as a project from the callout under the group header", async () => {
    let finish: (project: { name: string }) => void = () => undefined;
    createProjectFromRemote.mockReturnValue(
      new Promise((resolve) => (finish = resolve)),
    );
    render(
      <SshRepositoryNotAProjectCallout
        workspaces={[sshWorkspace()]}
        repoName="app"
      />,
    );

    expect(screen.getByText(/not a project here yet/)).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Add app as a project" });
    fireEvent.click(button);

    expect(createProjectFromRemote).toHaveBeenCalledWith({
      remoteUrl: "git@github.com:acme/app.git",
    });
    expect(button).toBeDisabled();
    await act(async () => finish({ name: "app" }));
    expect(button).not.toBeDisabled();
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({
        message: "Added app as a project",
        type: "success",
      }),
    ]);
  });

  it("links the group to a git project chosen from its menu", async () => {
    render(
      <SshRepositoryGroupContextMenu
        workspaces={[
          sshWorkspace(),
          sshWorkspace({ id: "ws-43" }),
          sshWorkspace({
            id: "ws-44",
            backend: { ...backend, hostId: "ssh-other" },
          }),
        ]}
      >
        <div>app</div>
      </SshRepositoryGroupContextMenu>,
    );

    expect(
      screen.queryByRole("menuitem", { name: "Notes" }),
    ).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Komla" }));
    });

    // One call per clone moves that clone's workspaces; the group spans two hosts.
    expect(linkSshWorkspaceToProject.mock.calls).toEqual([
      ["ws-43", "project-1"],
      ["ws-44", "project-1"],
    ]);
  });

  // A renamed repository, e.g. acme/old-app now acme/app, has another URL than the project here,
  // so it doesn't match; adding it again would make a second project named "app-2".
  describe("when a project here already has the repository’s name", () => {
    beforeEach(() => {
      useProjectsStore.setState({
        projects: [
          createProject({ id: "project-1", name: "Komla" }),
          createProject({ id: "project-app", name: "App" }),
          createProject({ id: "dir-app", name: "app", kind: "directory" }),
        ],
      });
    });

    it("offers to link the group to that project from the callout first", async () => {
      render(
        <SshRepositoryNotAProjectCallout
          workspaces={[
            sshWorkspace(),
            sshWorkspace({
              id: "ws-44",
              backend: { ...backend, hostId: "ssh-other" },
            }),
          ]}
          repoName="app"
        />,
      );

      expect(screen.getByText(/Is it your App project/)).toBeInTheDocument();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Link to App" }));
      });

      expect(linkSshWorkspaceToProject.mock.calls).toEqual([
        ["ws-42", "project-app"],
        ["ws-44", "project-app"],
      ]);
      expect(createProjectFromRemote).not.toHaveBeenCalled();
      // Adding it as its own project stays possible, e.g. for a fork.
      expect(
        screen.getByRole("button", { name: "Add app as a new project" }),
      ).toBeInTheDocument();
    });

    it("matches the project the host clone belongs to there", () => {
      render(
        <SshRepositoryNotAProjectCallout
          workspaces={[
            sshWorkspace({
              repoName: "old-app",
              backend: {
                ...backend,
                gitUrl: "git@github.com:acme/old-app.git",
                projectName: "app",
              },
            }),
          ]}
          repoName="old-app"
        />,
      );

      expect(
        screen.getByRole("button", { name: "Link to App" }),
      ).toBeInTheDocument();
    });

    it("matches on any workspace of the group, not only the first", () => {
      render(
        <SshRepositoryNotAProjectCallout
          workspaces={[
            sshWorkspace({
              repoName: "old-app",
              backend: {
                ...backend,
                gitUrl: "git@github.com:acme/old-app.git",
              },
            }),
            sshWorkspace({
              id: "ws-44",
              repoName: "old-app",
              backend: {
                ...backend,
                hostId: "ssh-other",
                gitUrl: "git@github.com:acme/old-app.git",
                projectName: "app",
              },
            }),
          ]}
          repoName="old-app"
        />,
      );

      expect(
        screen.getByRole("button", { name: "Link to App" }),
      ).toBeInTheDocument();
    });

    it("reads the repository name from a URL as git spells it", () => {
      render(
        <SshRepositoryNotAProjectCallout
          workspaces={[
            sshWorkspace({
              backend: {
                ...backend,
                gitUrl: "https://github.com/acme/App.GIT#main",
              },
            }),
          ]}
          repoName="app"
        />,
      );

      expect(
        screen.getByRole("button", { name: "Link to App" }),
      ).toBeInTheDocument();
    });

    it("suggests no project when two here have the name", () => {
      useProjectsStore.setState({
        projects: [
          createProject({ id: "project-app", name: "App" }),
          createProject({ id: "project-fork", name: "app " }),
        ],
      });
      render(
        <SshRepositoryNotAProjectCallout
          workspaces={[sshWorkspace()]}
          repoName="app"
        />,
      );

      expect(
        screen.queryByRole("button", { name: /^Link to/ }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Add app as a project" }),
      ).toBeInTheDocument();
    });

    it("holds both choices while it links, then says where the workspaces went", async () => {
      let finish: () => void = () => undefined;
      linkSshWorkspaceToProject.mockReturnValue(
        new Promise<void>((resolve) => (finish = resolve)),
      );
      render(
        <SshRepositoryNotAProjectCallout
          workspaces={[sshWorkspace()]}
          repoName="app"
        />,
      );

      const link = screen.getByRole("button", { name: "Link to App" });
      fireEvent.click(link);
      expect(link).toBeDisabled();
      expect(
        screen.getByRole("button", { name: "Add app as a new project" }),
      ).toBeDisabled();

      await act(async () => finish());
      expect(link).not.toBeDisabled();
      expect(useToastStore.getState().toasts).toEqual([
        expect.objectContaining({ message: "Moved to App", type: "success" }),
      ]);
    });

    it("lists linking to that project first in the group menu", async () => {
      render(
        <SshRepositoryGroupContextMenu workspaces={[sshWorkspace()]}>
          <div>app</div>
        </SshRepositoryGroupContextMenu>,
      );

      const items = screen
        .getAllByRole("menuitem")
        .map((item) => item.textContent);
      expect(items[0]).toBe("Link to App");
      await act(async () => {
        fireEvent.click(screen.getByRole("menuitem", { name: "Link to App" }));
      });
      expect(linkSshWorkspaceToProject.mock.calls).toEqual([
        ["ws-42", "project-app"],
      ]);
    });
  });
});

import { normalize } from 'path';

import { describe, expect, it, vi } from 'vitest';

import {
  createDirectoryWorkspace,
  createProject,
  createSshWorkspace,
  createTerminal,
  createTrashedWorkspace,
  createWorktreeWorkspace,
} from '../../factories';
import { workspaceCwdResolutionService } from '../../../src/main/services/workspace-cwd-resolution.service';

const mockRealpathSync = vi.hoisted(() => {
  const realpath = vi.fn((path: string) => path);
  return Object.assign(realpath, { native: realpath });
});

vi.mock('fs', () => ({
  realpathSync: mockRealpathSync,
}));

describe('workspaceCwdResolutionService', () => {
  it('resolves a nested cwd to the deepest matching workspace', () => {
    const parent = createDirectoryWorkspace({
      id: 'ws-parent',
      workingDirectory: '/projects/app',
    });
    const child = createDirectoryWorkspace({
      id: 'ws-child',
      workingDirectory: '/projects/app/packages/web',
    });

    const result = workspaceCwdResolutionService.resolveWorkspaceByCwd(
      '/projects/app/packages/web/src',
      {
        workspaces: [parent, child],
        getProject: () => undefined,
        komlaBasePath: '/mock/home/.komla',
      },
      { rejectAmbiguousMatches: true }
    );

    expect(result.workspace?.id).toBe('ws-child');
  });

  it('uses the only running workspace when cwd fallback is otherwise ambiguous', () => {
    const stopped = createDirectoryWorkspace({
      id: 'ws-stopped',
      workingDirectory: '/projects/shared',
      terminals: [createTerminal({ status: 'stopped' })],
    });
    const running = createDirectoryWorkspace({
      id: 'ws-running',
      workingDirectory: '/projects/shared',
      terminals: [createTerminal({ status: 'running' })],
    });

    const result = workspaceCwdResolutionService.resolveWorkspaceByCwd(
      '/projects/shared/src',
      {
        workspaces: [stopped, running],
        getProject: () => undefined,
        komlaBasePath: '/mock/home/.komla',
      },
      { rejectAmbiguousMatches: true }
    );

    expect(result.workspace?.id).toBe('ws-running');
  });

  it('rejects ambiguous cwd fallback when no single running workspace is obvious', () => {
    const first = createDirectoryWorkspace({
      id: 'ws-1',
      workingDirectory: '/projects/shared',
      terminals: [createTerminal({ status: 'stopped' })],
    });
    const second = createDirectoryWorkspace({
      id: 'ws-2',
      workingDirectory: '/projects/shared',
      terminals: [createTerminal({ status: 'stopped' })],
    });

    const result = workspaceCwdResolutionService.resolveWorkspaceByCwd(
      '/projects/shared/src',
      {
        workspaces: [first, second],
        getProject: () => undefined,
        komlaBasePath: '/mock/home/.komla',
      },
      { rejectAmbiguousMatches: true }
    );

    expect(result).toEqual({
      error:
        'Multiple workspaces match cwd: /projects/shared/src. This MCP tool cannot safely choose a workspace unless exactly one matching workspace is running.',
    });
  });

  it('derives a project from cwd matches without requiring a single source workspace', () => {
    const project = createProject({ id: 'proj-1', kind: 'directory' });
    const first = createDirectoryWorkspace({
      id: 'ws-1',
      projectId: 'proj-1',
      workingDirectory: '/projects/shared',
      terminals: [createTerminal({ status: 'running' })],
      windowId: 'window-1',
    });
    const second = createDirectoryWorkspace({
      id: 'ws-2',
      projectId: 'proj-1',
      workingDirectory: '/projects/shared',
      terminals: [createTerminal({ status: 'running' })],
      windowId: 'window-2',
    });

    const result = workspaceCwdResolutionService.findProjectByCwd('/projects/shared/src', {
      workspaces: [first, second],
      getProject: (id) => (id === project.id ? project : undefined),
      komlaBasePath: '/mock/home/.komla',
    });

    expect(result.project?.id).toBe('proj-1');
    expect(result.sourceWorkspace).toBeUndefined();
  });

  it("matches an SSH workspace by its remote directory without resolving it on this machine's disk", () => {
    // On macOS, a lookup under /home goes through the automounter and can take tens of
    // milliseconds, which blocks the main process when it is done for every workspace.
    mockRealpathSync.mockClear();
    const remote = createSshWorkspace({
      id: 'ws-remote',
      backend: {
        kind: 'ssh',
        hostId: 'ssh-host-1',
        remoteDirectory: '/home/dev/.komla/worktrees/project/branch',
        remoteRepoPath: '/home/dev/.komla/repos/project/repo.git',
        remoteProjectRoot: '/home/dev/.komla/worktrees/project',
      },
    });

    const result = workspaceCwdResolutionService.resolveWorkspaceByCwd(
      '/home/dev/.komla/worktrees/project/branch/src',
      { workspaces: [remote], getProject: () => undefined, komlaBasePath: '/mock/home/.komla' },
      { rejectAmbiguousMatches: true }
    );

    expect(result.workspace?.id).toBe('ws-remote');
    expect(mockRealpathSync).not.toHaveBeenCalledWith(expect.stringMatching(/^\/home\/dev/));
  });

  it("doesn't resolve a cwd from an SSH host on this machine's disk when no SSH workspace matches it", () => {
    mockRealpathSync.mockClear();
    const remote = createSshWorkspace({ id: 'ws-remote' });

    const result = workspaceCwdResolutionService.resolveWorkspaceByCwd(
      '/home/dev/.komla/worktrees/other-project/other-branch',
      { workspaces: [remote], getProject: () => undefined, komlaBasePath: '/mock/home/.komla' },
      { rejectAmbiguousMatches: true }
    );

    expect(result.error).toBeDefined();
    expect(mockRealpathSync).not.toHaveBeenCalledWith(expect.stringMatching(/^\/home\/dev/));
  });

  it('resolves each local workspace directory on disk at most once per lookup', () => {
    mockRealpathSync.mockClear();
    const workspaces = [
      createDirectoryWorkspace({ id: 'ws-a', workingDirectory: '/projects/a' }),
      createDirectoryWorkspace({ id: 'ws-b', workingDirectory: '/projects/b' }),
    ];

    workspaceCwdResolutionService.resolveWorkspaceByCwd(
      '/elsewhere/entirely',
      { workspaces, getProject: () => undefined, komlaBasePath: '/mock/home/.komla' },
      { rejectAmbiguousMatches: true }
    );

    const calls = mockRealpathSync.mock.calls.map(([path]) => path);
    expect(calls.filter((path) => path === normalize('/projects/a'))).toHaveLength(1);
    expect(calls.filter((path) => path === normalize('/projects/b'))).toHaveLength(1);
  });

  it('leaves trashed workspaces out of cwd matches', () => {
    const trashed = createTrashedWorkspace({ id: 'ws-trashed', workingDirectory: '/projects/app' });
    const active = createDirectoryWorkspace({ id: 'ws-active', workingDirectory: '/projects/app' });

    const result = workspaceCwdResolutionService.resolveWorkspaceByCwd(
      '/projects/app',
      {
        workspaces: [trashed, active],
        getProject: () => undefined,
        komlaBasePath: '/mock/home/.komla',
      },
      { rejectAmbiguousMatches: true }
    );

    expect(result.workspace?.id).toBe('ws-active');
  });

  it('leaves trashed workspaces out of the managed worktree path match', () => {
    const trashed = createTrashedWorkspace({
      id: 'ws-trashed',
      isWorktree: true,
      workingDirectory: '/missing/path',
      repoName: 'project',
      branchName: 'feature',
    });

    const result = workspaceCwdResolutionService.resolveWorkspaceByCwd(
      '/mock/home/.komla/worktrees/project/feature',
      { workspaces: [trashed], getProject: () => undefined, komlaBasePath: '/mock/home/.komla' }
    );

    expect(result.workspace).toBeUndefined();
  });

  it('matches managed worktree paths by sanitized project segment and branch segment', () => {
    const workspace = createWorktreeWorkspace({
      id: 'ws-worktree',
      workingDirectory: '/missing/path',
      repoName: 'My Cool Project',
      branchName: 'agent/feature',
    });

    const result = workspaceCwdResolutionService.resolveWorkspaceByCwd(
      '/mock/home/.komla/worktrees/My-Cool-Project/agent-feature/src',
      {
        workspaces: [workspace],
        getProject: () => undefined,
        komlaBasePath: '/mock/home/.komla',
      }
    );

    expect(result.workspace?.id).toBe('ws-worktree');
  });
});

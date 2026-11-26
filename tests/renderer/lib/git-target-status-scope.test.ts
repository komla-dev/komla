import { describe, expect, it } from 'vitest';

import { getGitTargetStatusScope } from '../../../src/renderer/lib/git-target-status-scope';
import { createWorkspace } from '../../factories';

const sshBackend = {
  kind: 'ssh' as const,
  hostId: 'ssh-dev',
  remoteDirectory: '/home/dev/worktree',
  remoteRepoPath: '/home/dev/repo.git',
  remoteProjectRoot: '/home/dev',
  gitUrl: 'git@example.test:repo.git',
  projectName: 'Repo',
};

describe('getGitTargetStatusScope', () => {
  it('shares a scope between local worktrees of a project on the same target', () => {
    const first = createWorkspace({ projectId: 'project-1' });
    const second = createWorkspace({ projectId: 'project-1' });

    expect(getGitTargetStatusScope(first, 'main')).toBeDefined();
    expect(getGitTargetStatusScope(first, 'main')).toBe(getGitTargetStatusScope(second, 'main'));
    expect(getGitTargetStatusScope(first, 'main')).not.toBe(
      getGitTargetStatusScope(second, 'release')
    );
  });

  it("shares a scope between local worktrees following the project's default branch", () => {
    // Neither the project nor the workspace names a target, so none is passed.
    const first = createWorkspace({ projectId: 'project-1' });
    const second = createWorkspace({ projectId: 'project-1' });

    expect(getGitTargetStatusScope(first)).toBeDefined();
    expect(getGitTargetStatusScope(first)).toBe(getGitTargetStatusScope(second));
  });

  it("keeps a local worktree's scope apart from an SSH worktree's in the same project", () => {
    const local = createWorkspace({ projectId: 'project-1' });
    const ssh = createWorkspace({ projectId: 'project-1', backend: sshBackend });

    expect(getGitTargetStatusScope(ssh, 'main')).toBeDefined();
    expect(getGitTargetStatusScope(local, 'main')).not.toBe(getGitTargetStatusScope(ssh, 'main'));
  });

  it('gives no scope to a directory workspace, a scratch SSH one or one without a project', () => {
    expect(getGitTargetStatusScope(createWorkspace({ isWorktree: false, projectId: 'p' }), 'main'))
      .toBeUndefined();
    expect(getGitTargetStatusScope(createWorkspace({ projectId: null }), 'main')).toBeUndefined();
    expect(
      getGitTargetStatusScope(
        createWorkspace({ projectId: 'p', backend: { ...sshBackend, scratch: true } as never }),
        'main'
      )
    ).toBeUndefined();
  });
});

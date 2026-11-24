import { execFile } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createWorkspace } from '../../../factories';
import { mockElectron } from '../../../mocks/electron';

vi.mock('electron', () => mockElectron());

const { run } = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock('../../../../src/main/services/ssh-workspace.service', () => ({
  sshWorkspaceService: {
    getHost: (id: string) => ({ id, name: 'dev box' }),
    run,
  },
}));
vi.mock('../../../../src/main/services/workspace-status.service', () => ({
  workspaceStatusService: { read: () => undefined },
}));

import { sshWorkspaceDiff } from '../../../../src/main/services/workspace-git/ssh-diff';

const execFileAsync = promisify(execFile);

/** The host's shell, here this computer's. */
async function hostShell(_host: unknown, command: string): Promise<string> {
  const { stdout } = await execFileAsync('sh', ['-c', command]);
  return stdout;
}

/** The host's shell after a login profile that prints a greeting. */
async function greetingHostShell(host: unknown, command: string): Promise<string> {
  return await hostShell(host, `echo 'Welcome back'; ${command}`);
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', ...args], {
    cwd,
  });
}

const sshWorkspace = (remoteDirectory: string) =>
  createWorkspace({
    workingDirectory: `ssh://dev${remoteDirectory}`,
    backend: {
      kind: 'ssh',
      hostId: 'dev',
      remoteDirectory,
      remoteRepoPath: remoteDirectory,
      remoteProjectRoot: remoteDirectory,
      gitUrl: 'git@example.com:komla/app.git',
    },
  });

const noChanges = {
  files: [],
  summary: { additions: 0, deletions: 0, filesChanged: 0 },
};

describe('sshWorkspaceDiff', () => {
  let root: string;
  let repo: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'komla-ssh-diff-'));
    repo = join(root, 'repo');
    await git(root, 'init', '--quiet', '-b', 'main', repo);
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    await git(repo, 'add', 'a.txt');
    await git(repo, 'commit', '--quiet', '-m', 'first');
    run.mockReset().mockImplementation(hostShell);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("reads the working tree's changes on the host", async () => {
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');

    const diff = await sshWorkspaceDiff.getWorkingTreeDiff(sshWorkspace(repo));

    expect(diff.files).toEqual([
      expect.objectContaining({
        path: 'a.txt',
        status: 'modified',
        additions: 1,
        deletions: 0,
      }),
    ]);
  });

  it('answers no changes when the workspace folder is gone from its host', async () => {
    run.mockImplementation(greetingHostShell);
    const workspace = sshWorkspace(join(root, 'deleted-worktree'));

    await expect(sshWorkspaceDiff.getWorkingTreeDiff(workspace)).resolves.toEqual(noChanges);
    await expect(
      sshWorkspaceDiff.getWorkingTreeDiffAgainstBranch(workspace, 'main', true)
    ).resolves.toEqual(noChanges);
  });

  it("fails a diff that can't enter a workspace folder still on its host", async () => {
    const notAFolder = join(root, 'not-a-folder');
    writeFileSync(notAFolder, '');

    await expect(sshWorkspaceDiff.getWorkingTreeDiff(sshWorkspace(notAFolder))).rejects.toThrow(
      /not-a-folder/
    );
  });

  it("says a file's diff can't be read when the workspace folder is gone from its host", async () => {
    const workspace = sshWorkspace(join(root, 'deleted-worktree'));

    await expect(sshWorkspaceDiff.getFullFileDiff(workspace, 'a.txt', false)).rejects.toThrow(
      "The workspace's folder is gone from dev box."
    );
  });
});

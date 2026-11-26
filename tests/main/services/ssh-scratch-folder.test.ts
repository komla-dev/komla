/* eslint-disable import/order -- Vitest's hoisted mocks must precede service imports. */
/**
 * Scratch folders on an SSH host. The host is a local directory: the SSH layer runs each remote
 * command with `sh`, so the real scripts that make and delete the folders run against real files.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mockElectron } from '../../mocks/electron';

const holder = vi.hoisted(() => ({
  host: undefined as undefined | Record<string, unknown>,
  home: '',
}));

vi.mock('electron', () => mockElectron());

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const { promisify } = await import('node:util');
  type Callback = (error: Error | null, stdout: string, stderr: string) => void;
  function execFile(file: string, args: string[], options: object, callback?: Callback) {
    if (file !== 'ssh') return actual.execFile(file, args, options, callback);
    // ssh's last argument is the remote command; run it on this machine, in the host's home.
    const env = { ...process.env, ...(options as { env?: object }).env, HOME: holder.home };
    return actual.execFile('sh', ['-c', String(args.at(-1))], { ...options, env }, callback);
  }
  (execFile as unknown as Record<symbol, unknown>)[promisify.custom] = (
    file: string,
    args: string[],
    options: object = {}
  ) =>
    new Promise((resolve, reject) => {
      execFile(file, args, options, (error, stdout, stderr) =>
        error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr })
      );
    });
  return { ...actual, execFile };
});

vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../../src/main/services/askpass.service', () => ({
  askpassService: {
    isRunning: vi.fn(() => false),
    getHelperScriptPath: vi.fn(() => null),
    getSocketPath: vi.fn(() => null),
  },
}));

vi.mock('../../../src/main/services/config.service', () => ({
  configService: { get: () => ({ sshHosts: [holder.host] }) },
}));

vi.mock('../../../src/main/services/ssh-host.service', () => ({
  sshHostService: {
    has: (hostId: string) => hostId === 'ssh-dev',
    get: (hostId: string) => (hostId === 'ssh-dev' ? holder.host : undefined),
  },
}));

vi.mock('../../../src/main/services/http-server.service', () => ({
  httpServerService: { getActualPort: vi.fn(() => 54183) },
}));

const { isRemoteScratchFolder, sshWorkspaceService } =
  await import('../../../src/main/services/ssh-workspace.service');

let scratch = '';
let base = '';

beforeEach(() => {
  // The host resolves its base path with `pwd -P`, and macOS's tmpdir is under the /var symlink.
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'komla-ssh-scratch-')));
  holder.home = join(scratch, 'host');
  base = join(holder.home, '.komla');
  mkdirSync(holder.home, { recursive: true });
  holder.host = { id: 'ssh-dev', name: 'Host', hostname: 'localhost', user: 'dev' };
  // Every test's host has the same connection, so the last test's resolved folder would stick.
  sshWorkspaceService.forgetHost('ssh-dev');
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('remote scratch folders', () => {
  it('counts only folders directly in the scratch folder under the base path', () => {
    expect(isRemoteScratchFolder('/home/dev/.komla', '/home/dev/.komla/scratch/swift-fox')).toBe(
      true
    );
    for (const folder of [
      '/home/dev/.komla/scratch',
      '/home/dev/.komla/scratch/',
      '/home/dev/.komla/scratch/swift-fox/inner',
      '/home/dev/.komla/scratch/..',
      '/home/dev/.komla/scratch/../worktrees',
      '/home/dev/.komla/scratch/./swift-fox',
      '/home/dev/.komla/worktrees/app/main',
      '/home/dev/scratch/swift-fox',
      '',
    ]) {
      expect(isRemoteScratchFolder('/home/dev/.komla', folder), folder).toBe(false);
    }
  });
});

describe.skipIf(process.platform === 'win32')('scratch folders on an SSH host', () => {
  it('makes an empty folder of its own in the host’s scratch folder', async () => {
    const first = await sshWorkspaceService.createScratchFolder('ssh-dev', ['swift-fox']);
    const second = await sshWorkspaceService.createScratchFolder('ssh-dev', ['calm-river']);

    expect(first).toEqual({
      kind: 'ssh',
      hostId: 'ssh-dev',
      remoteDirectory: join(base, 'scratch', 'swift-fox'),
      scratch: true,
    });
    expect(readdirSync(first.remoteDirectory)).toEqual([]);
    expect(second.remoteDirectory).toBe(join(base, 'scratch', 'calm-river'));
  });

  it('never hands out a folder that is already there', async () => {
    mkdirSync(join(base, 'scratch', 'swift-fox'), { recursive: true });
    writeFileSync(join(base, 'scratch', 'swift-fox', 'notes.md'), 'keep me');

    const made = await sshWorkspaceService.createScratchFolder('ssh-dev', [
      'swift-fox',
      'calm-river',
    ]);

    expect(made.remoteDirectory).toBe(join(base, 'scratch', 'calm-river'));
    expect(readdirSync(join(base, 'scratch', 'swift-fox'))).toEqual(['notes.md']);
  });

  it('fails when every name is taken, without taking one over', async () => {
    mkdirSync(join(base, 'scratch', 'swift-fox'), { recursive: true });

    await expect(
      sshWorkspaceService.createScratchFolder('ssh-dev', ['swift-fox'])
    ).rejects.toThrow();
    expect(readdirSync(join(base, 'scratch'))).toEqual(['swift-fox']);
  });

  it('makes it where a linked ~/.komla really is, and deletes it there', async () => {
    const data = join(scratch, 'data');
    mkdirSync(data);
    symlinkSync(data, base);

    const made = await sshWorkspaceService.createScratchFolder('ssh-dev', ['swift-fox']);
    expect(made.remoteDirectory).toBe(join(data, 'scratch', 'swift-fox'));

    await sshWorkspaceService.deleteScratchFolder(made);
    expect(existsSync(made.remoteDirectory)).toBe(false);
    expect(existsSync(join(data, 'scratch'))).toBe(true);
  });

  it('deletes a scratch folder with everything in it', async () => {
    const made = await sshWorkspaceService.createScratchFolder('ssh-dev', ['swift-fox']);
    mkdirSync(join(made.remoteDirectory, 'src'));
    writeFileSync(join(made.remoteDirectory, 'src', 'main.py'), 'print(1)');

    await sshWorkspaceService.deleteScratchFolder(made);

    expect(existsSync(made.remoteDirectory)).toBe(false);
    expect(existsSync(join(base, 'scratch'))).toBe(true);
  });

  it('deletes a folder already gone without failing', async () => {
    const made = await sshWorkspaceService.createScratchFolder('ssh-dev', ['swift-fox']);
    rmSync(made.remoteDirectory, { recursive: true });

    await expect(sshWorkspaceService.deleteScratchFolder(made)).resolves.toBeUndefined();
  });

  it('refuses to delete any folder outside the host’s scratch folder', async () => {
    const worktree = join(base, 'worktrees', 'app', 'main');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, 'README.md'), 'mine');
    mkdirSync(join(base, 'scratch'), { recursive: true });

    for (const remoteDirectory of [
      worktree,
      join(base, 'scratch'),
      `${join(base, 'scratch')}/../worktrees/app`,
      holder.home,
    ]) {
      await expect(
        sshWorkspaceService.deleteScratchFolder({
          kind: 'ssh',
          hostId: 'ssh-dev',
          remoteDirectory,
          scratch: true,
        }),
        remoteDirectory
      ).rejects.toThrow('Refusing');
    }
    expect(existsSync(join(worktree, 'README.md'))).toBe(true);
    expect(existsSync(join(base, 'scratch'))).toBe(true);
  });
});

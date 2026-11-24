/**
 * Adding a git project makes its own folder under `repos/`, and never removes a folder that was
 * already there unless an earlier Komla attempt left it unfinished. These run real git and the
 * real filesystem against scratch directories.
 */
import { execFile } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockElectron } from '../../mocks/electron';

const execFileAsync = promisify(execFile);

const { komlaBase } = vi.hoisted(() => ({ komlaBase: { path: '' } }));

vi.mock('electron', () => mockElectron());
vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}));
vi.mock('../../../src/main/services/askpass.service', () => ({
  askpassService: {
    isRunning: vi.fn(() => false),
    getHelperScriptPath: vi.fn(),
    getSocketPath: vi.fn(),
  },
}));
vi.mock('../../../src/main/services/paths', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getKomlaBasePath: () => komlaBase.path,
}));

describe('the project folder of a git project', () => {
  let tempDir: string;
  let source: string;
  let projectFolder: string;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = mkdtempSync(join(tmpdir(), 'komla-project-folder-'));
    komlaBase.path = join(tempDir, 'komla');
    projectFolder = join(komlaBase.path, 'repos', 'app');
    vi.stubEnv('GIT_CONFIG_GLOBAL', join(tempDir, 'gitconfig'));
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.stubEnv('GIT_AUTHOR_NAME', 'Ada');
    vi.stubEnv('GIT_AUTHOR_EMAIL', 'ada@example.com');
    vi.stubEnv('GIT_COMMITTER_NAME', 'Ada');
    vi.stubEnv('GIT_COMMITTER_EMAIL', 'ada@example.com');

    source = join(tempDir, 'app');
    await git(tempDir, 'init', '-q', '-b', 'main', source);
    await git(source, 'commit', '-q', '--allow-empty', '-m', 'first');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function git(cwd: string, ...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd });
    return stdout.trim();
  }

  async function loadService() {
    const { projectService } = await import('../../../src/main/services/project.service');
    return projectService;
  }

  it('leaves a repository the user put at its path as it was, and adds the project beside it', async () => {
    // Such as a copy of the repository the user made there themselves before adding it.
    await git(tempDir, 'clone', '-q', '--bare', source, join(projectFolder, '.git'));
    writeFileSync(join(projectFolder, 'notes.txt'), 'mine');
    const before = readdirSync(join(projectFolder, '.git'));
    const projectService = await loadService();

    await expect(projectService.create({ repositoryPath: source, name: 'app' })).rejects.toThrow(
      `A folder already exists at ${projectFolder}. Choose another name, or remove the folder.`
    );
    expect(projectService.list()).toEqual([]);

    // Named after the repository instead, it takes the next free name.
    const project = await projectService.create({ repositoryPath: source });
    expect(project.name).toBe('app-2');
    expect(project.managedRepoPath).toBe(join(komlaBase.path, 'repos', 'app-2', '.git'));

    expect(readdirSync(join(projectFolder, '.git'))).toEqual(before);
    expect(existsSync(join(projectFolder, 'notes.txt'))).toBe(true);
    expect(await git(join(projectFolder, '.git'), 'rev-parse', '--verify', 'main')).toMatch(
      /^[0-9a-f]{40}$/
    );
  });

  it('replaces what an unfinished attempt left, and leaves a finished folder unmarked', async () => {
    mkdirSync(join(projectFolder, '.git'), { recursive: true });
    writeFileSync(join(projectFolder, '.komla-creating'), '');
    writeFileSync(join(projectFolder, '.git', 'partial'), '');
    const projectService = await loadService();

    const project = await projectService.create({ repositoryPath: source });

    expect(project.managedRepoPath).toBe(join(projectFolder, '.git'));
    expect(existsSync(join(projectFolder, '.git', 'partial'))).toBe(false);
    expect(existsSync(join(projectFolder, '.komla-creating'))).toBe(false);
    expect(await git(join(projectFolder, '.git'), 'rev-parse', '--is-bare-repository')).toBe(
      'true'
    );
  });
});

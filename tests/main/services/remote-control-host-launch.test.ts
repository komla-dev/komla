import { beforeEach, describe, expect, it, vi } from 'vitest';

import { encodedJsonBytes, MAX_ENCRYPTED_BODY_BYTES } from '@komla/remote-protocol';

import type { AgentPreset } from '../../../src/shared/types/agent-preset';
import type { Project } from '../../../src/shared/types/project';

const state = vi.hoisted(() => ({
  projects: [] as Project[],
  presets: new Map<string, AgentPreset>(),
  remotes: new Map<string, string>(),
  config: {} as Record<string, unknown>,
  isolated: false,
}));

vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../src/main/services/config.service', () => ({
  configService: {
    get: vi.fn(() => ({
      defaultLaunchModeId: 'auto',
      gitDefaults: { branchPrefix: 'me/' },
      ...state.config,
    })),
  },
}));
vi.mock('../../../src/main/services/ssh-host.service', () => ({
  sshHostService: { get: (id: string) => ({ id, name: id, isolated: state.isolated }) },
}));
vi.mock('../../../src/main/services/project.service', () => ({
  projectService: { list: () => state.projects },
}));
vi.mock('../../../src/main/services/git.service', () => ({
  gitService: {
    getRemoteUrl: async (path: string) => {
      const url = state.remotes.get(path);
      if (!url) throw new Error('no remote');
      return url;
    },
  },
}));
vi.mock('../../../src/main/services/ssh-workspace.service', () => ({
  sshWorkspaceService: {
    createWorkspacePlan: (args: {
      projectName: string;
      gitUrl: string;
      resolvedBasePath: string;
    }) => {
      if (args.gitUrl === 'BROKEN') throw new Error('unexpected remote');
      return {
        backend: {
          remoteRepoPath: `${args.resolvedBasePath}/repos/${args.projectName}/repo.git`,
          remoteProjectRoot: `${args.resolvedBasePath}/worktrees/${args.projectName}`,
          gitUrl: args.gitUrl,
        },
      };
    },
  },
}));
vi.mock('../../../src/main/services/agent-preset.service', () => ({
  agentPresetService: {
    getActivePresets: () =>
      [...state.presets.keys()].map((presetId) => ({
        presetId,
        lastUsedAt: 1,
        ...(presetId === 'claude' ? { lastLaunchModeId: null } : {}),
      })),
    get: (id: string) => state.presets.get(id),
    resolvePosixPromptTemplate: (preset: AgentPreset, modeId?: string) => {
      if (!preset.promptCommand || modeId === 'windows-only') return undefined;
      // A preset whose plain command runs only on Windows.
      if (!modeId && preset.openCommand === 'windows-only') return undefined;
      const mode = modeId ? ` --${modeId}` : '';
      return {
        promptCommand: `${preset.promptCommand}${mode} {{prompt}}`,
        openCommand: `${preset.openCommand}${mode}`,
      };
    },
    resolvePosixContinueCommand: (preset: AgentPreset, modeId?: string) =>
      preset.continueCommand
        ? `${preset.continueCommand}${modeId ? ` --${modeId}` : ''}`
        : undefined,
  },
}));

import {
  buildHostLaunchFile,
  configureHostLaunch,
  withProjectIcons,
} from '../../../src/main/services/remote-control-host-launch';

function project(overrides: Partial<Project>): Project {
  return {
    id: 'p-app',
    name: 'app',
    repositoryPath: '/Users/me/app',
    defaultBranchPrefix: '',
    createdAt: 1,
    order: 0,
    managed: false,
    ...overrides,
  } as Project;
}

function preset(overrides: Partial<AgentPreset>): AgentPreset {
  return {
    id: 'claude',
    name: 'Claude Code',
    promptCommand: 'claude',
    openCommand: 'claude',
    continueCommand: 'claude --resume',
    launchModes: [{ id: 'yolo', name: 'YOLO' }],
    ...overrides,
  } as AgentPreset;
}

describe('buildHostLaunchFile', () => {
  beforeEach(() => {
    state.projects = [];
    state.presets = new Map();
    state.remotes = new Map();
    state.config = {};
    state.isolated = false;
    configureHostLaunch({
      projectIdsOnHost: (hostId) =>
        new Set(hostId === 'host-1' ? ['p-app', 'p-local', 'p-folder', 'p-broken'] : []),
    });
  });

  it('lists git projects with their host paths and each agent mode the host can start', async () => {
    state.projects = [
      project({ baseBranch: 'origin/main' }),
      project({ id: 'p-local', name: 'local', repositoryPath: '/Users/me/local' }),
      project({ id: 'p-folder', name: 'notes', kind: 'directory', repositoryPath: '/notes' }),
      project({ id: 'p-elsewhere', name: 'elsewhere', repositoryPath: '/Users/me/elsewhere' }),
      project({ id: 'p-broken', name: 'broken', repositoryPath: '/Users/me/broken' }),
    ];
    state.remotes.set('/Users/me/app', 'git@github.com:me/app.git');
    state.remotes.set('/notes', 'git@github.com:me/notes.git');
    state.remotes.set('/Users/me/elsewhere', 'git@github.com:me/elsewhere.git');
    // A git failure is caught per project already; a throw from anywhere else must be too.
    state.remotes.set('/Users/me/broken', 'BROKEN');
    state.presets.set(
      'claude',
      preset({
        launchModes: [
          { id: 'yolo', name: 'YOLO' },
          { id: 'windows-only', name: 'Windows' },
        ],
      } as Partial<AgentPreset>)
    );
    state.presets.set('custom', preset({ id: 'custom', name: 'Custom', promptCommand: '' }));

    const file = JSON.parse(await buildHostLaunchFile('host-1', '/home/me/.komla'));

    expect(file).toMatchObject({ version: 1, hostId: 'host-1', defaultLaunchModeId: 'auto' });
    expect(file.projects).toEqual([
      {
        summary: expect.objectContaining({
          id: 'p-app',
          name: 'app',
          repositoryPath: '/home/me/.komla/worktrees/app',
        }),
        remoteRepoPath: '/home/me/.komla/repos/app/repo.git',
        remoteProjectRoot: '/home/me/.komla/worktrees/app',
        gitUrl: 'git@github.com:me/app.git',
        projectName: 'app',
        baseBranch: 'main',
        branchPrefix: 'me/',
      },
    ]);
    expect(file.presets).toEqual([
      {
        summary: {
          id: 'claude',
          name: 'Claude Code',
          launchModes: [{ id: 'yolo', name: 'YOLO' }],
          lastLaunchModeId: null,
        },
        launches: [
          {
            promptCommand: 'claude {{prompt}}',
            openCommand: 'claude',
            continueCommand: 'claude --resume',
          },
          {
            launchModeId: 'yolo',
            promptCommand: 'claude --yolo {{prompt}}',
            openCommand: 'claude --yolo',
            continueCommand: 'claude --resume --yolo',
          },
        ],
      },
    ]);
  });

  describe('what Outside Agents may start there', () => {
    beforeEach(() => {
      state.projects = [project({})];
      state.remotes.set('/Users/me/app', 'git@github.com:me/app.git');
      state.presets.set(
        'claude',
        preset({
          launchModes: [
            { id: 'plan', name: 'Plan', arguments: '--permission-mode plan' },
            { id: 'yolo', name: 'YOLO', arguments: '--dangerously-skip-permissions' },
            { id: 'mine', name: 'Mine', agentLaunch: 'never' },
          ],
        } as Partial<AgentPreset>)
      );
    });

    it('allows the modes agents may start on a host that is not isolated', async () => {
      const file = JSON.parse(await buildHostLaunchFile('host-1', '/home/me/.komla'));

      expect(file.agentLaunch).toEqual({
        allowed: [{ presetId: 'claude' }, { presetId: 'claude', launchModeId: 'plan' }],
      });
    });

    it('allows an agent without a mode only when the host can start it so', async () => {
      state.presets.set(
        'claude',
        preset({ launchModes: [{ id: 'plan', name: 'Plan' }] } as Partial<AgentPreset>)
      );
      state.presets.set(
        'noplain',
        preset({ id: 'noplain', name: 'No plain', promptCommand: 'np' })
      );
      const withoutPlain = state.presets.get('noplain')!;
      // Only its Plan mode has a POSIX command on the host.
      withoutPlain.launchModes = [{ id: 'plan', name: 'Plan' }];
      withoutPlain.openCommand = 'windows-only';

      const file = JSON.parse(await buildHostLaunchFile('host-1', '/home/me/.komla'));

      expect(file.agentLaunch.allowed).toContainEqual({ presetId: 'claude' });
      expect(file.agentLaunch.allowed).not.toContainEqual({ presetId: 'noplain' });
    });

    it('allows a mode that skips permission prompts on a host marked isolated', async () => {
      state.isolated = true;

      const file = JSON.parse(await buildHostLaunchFile('host-1', '/home/me/.komla'));

      expect(file.agentLaunch.allowed).toEqual([
        { presetId: 'claude' },
        { presetId: 'claude', launchModeId: 'plan' },
        { presetId: 'claude', launchModeId: 'yolo' },
      ]);
    });

    it('starts the agent and mode pinned for agent launches, which agents may always start', async () => {
      state.config = {
        agentLaunchDefaultPresetId: 'claude',
        agentLaunchDefaultLaunchModeId: 'yolo',
      };

      const file = JSON.parse(await buildHostLaunchFile('host-1', '/home/me/.komla'));

      expect(file.agentLaunch).toEqual({
        default: { presetId: 'claude', launchModeId: 'yolo' },
        allowed: [
          { presetId: 'claude' },
          { presetId: 'claude', launchModeId: 'plan' },
          { presetId: 'claude', launchModeId: 'yolo' },
        ],
      });
    });
  });

  it("gives projects their icons while the host's launch options still fit one frame", async () => {
    const icon = (fill: string) => `data:image/png;base64,${fill.repeat(15_000)}`;
    const ids = ['p-app', 'p-local', 'p-folder', 'p-broken'];
    configureHostLaunch({ projectIdsOnHost: () => new Set([...ids, 'p-huge', 'p-html']) });
    state.projects = [
      ...ids.map((id, index) =>
        project({ id, name: id, repositoryPath: `/r/${id}`, icon: icon('ABCD'[index]!) })
      ),
      project({
        id: 'p-huge',
        name: 'huge',
        repositoryPath: '/r/p-huge',
        icon: `data:image/svg+xml;base64,${'A'.repeat(20_000)}`,
      }),
      project({
        id: 'p-html',
        name: 'html',
        repositoryPath: '/r/p-html',
        icon: 'data:text/html;base64,PGI+',
      }),
    ];
    for (const entry of state.projects)
      state.remotes.set(entry.repositoryPath, `git@x:${entry.id}`);
    state.presets.set('claude', preset({}));

    const file = JSON.parse(await buildHostLaunchFile('host-1', '/home/me/.komla'));

    expect(
      file.projects.map((entry: { summary: { id: string; icon?: string } }) => [
        entry.summary.id,
        entry.summary.icon?.length,
      ])
    ).toEqual([
      ['p-app', icon('A').length],
      ['p-local', icon('B').length],
      ['p-folder', icon('C').length],
      ['p-broken', undefined],
      ['p-huge', undefined],
      ['p-html', undefined],
    ]);
  });
});

describe('withProjectIcons', () => {
  it('counts what each icon adds to the frame to the byte', () => {
    const icon = 'data:image/png;base64,iVBORw0KGgo=';
    const summaries = ['a', 'b'].map((id) => ({ id, name: id, repositoryPath: `/r/${id}` }));
    const frame = { type: 'app:launch-options', projects: summaries };
    const added = encodedJsonBytes({
      ...frame,
      projects: [{ ...summaries[0]!, icon }, summaries[1]],
    });
    const iconBytes = added - encodedJsonBytes(frame);

    const projects = withProjectIcons(summaries, () => icon, MAX_ENCRYPTED_BODY_BYTES - iconBytes);

    expect(projects.map((project) => 'icon' in project)).toEqual([true, false]);
  });
});

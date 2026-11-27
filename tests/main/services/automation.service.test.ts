import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IPC } from '../../../src/shared/constants/ipc-channels';

import type { Automation, HostAutomation } from '../../../src/shared/types/automation';

type LaunchLocal = (
  automation: Automation,
  request: { trigger: 'schedule' | 'manual'; startedAt: number }
) => Promise<{ workspaceId: string }>;

const { dependencies, create, broadcastWhenReady } = vi.hoisted(() => ({
  dependencies: {} as { launchLocal?: unknown; compileForHost?: unknown },
  create: vi.fn(),
  broadcastWhenReady: vi.fn(),
}));

vi.mock('../../../src/main/services/automation/automation-service', () => ({
  AutomationService: class {
    constructor(given: { launchLocal: unknown; compileForHost: unknown }) {
      dependencies.launchLocal = given.launchLocal;
      dependencies.compileForHost = given.compileForHost;
    }
  },
}));
vi.mock('../../../src/main/services/automation/host-client', () => ({
  createAutomationHostClient: () => ({}),
}));
vi.mock('../../../src/main/services/automation/local-store', () => ({
  LocalAutomationStore: class {},
}));
vi.mock('../../../src/main/services/agent-preset.service', () => ({
  agentPresetService: {
    getPresetForWorkspace: () => ({ id: 'codex', name: 'Codex' }),
    resolvePosixPromptTemplate: () => ({
      promptCommand: 'codex {{prompt}}',
      openCommand: 'codex',
    }),
  },
}));
vi.mock('../../../src/main/services/config.service', () => ({
  configService: { getWorkspaceSyncDeviceId: () => 'device-1' },
}));
vi.mock('../../../src/main/services/git.service', () => ({ gitService: {} }));
vi.mock('../../../src/main/services/paths', () => ({ getKomlaBasePath: () => '/komla' }));
vi.mock('../../../src/main/services/project.service', () => ({
  projectService: { get: () => ({ id: 'p1', kind: 'git' }) },
}));
vi.mock('../../../src/main/services/remote-companion.service', () => ({
  remoteCompanionService: {},
}));
vi.mock('../../../src/main/services/ssh-host.service', () => ({ sshHostService: {} }));
vi.mock('../../../src/main/services/ssh-workspace.service', () => ({ sshWorkspaceService: {} }));
vi.mock('../../../src/main/services/window.service', () => ({
  windowService: { getMainWindowId: () => 'main-window', broadcastWhenReady },
}));
vi.mock('../../../src/main/services/workspace.service', () => ({
  workspaceService: { create },
}));

describe('an automation run on this computer', () => {
  const automation = {
    name: 'Nightly deps',
    projectId: 'p1',
    prompt: 'Update the dependencies.',
    schedule: { timeZone: 'Europe/Oslo' },
  } as Automation;
  const workspace = { id: 'ws-run', projectId: 'p1' };
  let launchLocal: LaunchLocal;

  beforeEach(async () => {
    broadcastWhenReady.mockClear();
    create.mockReset().mockResolvedValue(workspace);
    await import('../../../src/main/services/automation.service');
    launchLocal = dependencies.launchLocal as LaunchLocal;
  });

  // Windows bring a workspace someone asked for into sight, and leave a scheduled one be.
  it.each([
    { trigger: 'schedule' as const, scheduled: true },
    { trigger: 'manual' as const, scheduled: false },
  ])('tells windows whether its schedule started it: $trigger', async ({ trigger, scheduled }) => {
    await launchLocal(automation, { trigger, startedAt: Date.UTC(2026, 9, 15, 7) });

    expect(broadcastWhenReady).toHaveBeenCalledWith(IPC.WORKSPACE_CREATED, workspace, {
      scheduled,
    });
  });
  it('starts each run of a scratch automation in a new Scratch workspace, outside any project', async () => {
    const scratch = { ...automation, projectId: undefined, scratch: true } as Automation;

    await launchLocal(scratch, { trigger: 'manual', startedAt: Date.UTC(2026, 9, 15, 7) });

    const params = create.mock.calls[0]?.[0];
    expect(params).toMatchObject({
      mode: 'directory',
      scratch: true,
      customName: 'Nightly deps',
      initialPrompt: 'Update the dependencies.',
      environment: { kind: 'local' },
    });
    expect(params).not.toHaveProperty('projectId');
    expect(params).not.toHaveProperty('branchName');
  });
});

describe('an automation run on an SSH host', () => {
  it('has the host start each run of a scratch automation in a Scratch workspace', async () => {
    await import('../../../src/main/services/automation.service');
    const compileForHost = dependencies.compileForHost as (
      automation: Automation
    ) => Promise<HostAutomation>;

    const compiled = await compileForHost({
      id: 'summary',
      name: 'Daily summary',
      prompt: 'Summarize yesterday.',
      scratch: true,
      target: { kind: 'ssh', hostId: 'host-1' },
      presetId: 'codex',
      schedule: { cron: '0 9 * * *', timeZone: 'Europe/Oslo' },
      enabled: true,
      missedRunGraceMinutes: 720,
      createdAt: 1,
      updatedAt: 2,
    });

    expect(compiled).toEqual({
      schema: 1,
      id: 'summary',
      name: 'Daily summary',
      prompt: 'Summarize yesterday.',
      enabled: true,
      schedule: { cron: '0 9 * * *', timeZone: 'Europe/Oslo' },
      missedRunGraceMinutes: 720,
      scratch: true,
      launch: { agentName: 'Codex', promptCommand: 'codex {{prompt}}', openCommand: 'codex' },
      desktop: { presetId: 'codex' },
      createdAt: 1,
      updatedAt: 2,
      writtenBy: 'device-1',
    });
  });
});

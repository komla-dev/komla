import { describe, expect, it, vi } from 'vitest';

import {
  KomlaOperationService,
  type KomlaOperationDependencies,
} from '../../../src/main/services/komla-operation/operation';
import { komlaOperationResultSchemas } from '../../../src/main/services/komla-operation/result-schema';
import { parseKomlaOperation } from '../../../src/main/services/komla-operation/schema';
import { DEFAULT_WORKSPACE_TAGS } from '../../../src/shared/lib/workspace-tags';

// The limits an Agent Token puts on an Outside Agent's operations (ADR 0013).

function createDependencies(
  overrides: Partial<KomlaOperationDependencies> = {}
): KomlaOperationDependencies {
  return {
    getConfig: () => ({}),
    listPresets: () => [],
    getActivePresets: () => [],
    listProjects: () => [],
    getWorkspace: () => undefined,
    listWorkspaces: () => [],
    workspaceTags: () => DEFAULT_WORKSPACE_TAGS,
    saveWorkspaceTags: () => {},
    findWorkspaceByTerminalId: () => undefined,
    getProject: () => undefined,
    getProjectRemoteUrl: async () => 'git@example/repository.git',
    resolveWorkspaceByCwd: () => ({}),
    resolveProjectByCwd: () => ({}),
    resolveEnvironment: () => ({ kind: 'local' }),
    isSshHostReady: () => true,
    listSshHosts: () => [],
    getCheckedOutBranch: async (workspace) => workspace.branchName,
    isBranchOnOrigin: async () => true,
    createWorkspace: vi.fn(),
    addAgentTab: vi.fn(),
    updateWorkspace: vi.fn(),
    setStatusItem: vi.fn(() => true),
    clearStatusItems: vi.fn(() => 0),
    refreshStatusCommand: vi.fn(async () => undefined),
    publish: vi.fn(),
    getMainWindowId: () => undefined,
    getVncAppName: () => '',
    isWorkspaceShown: () => true,
    isAgentTurnActive: () => false,
    watchAgentTurnEnd: vi.fn(() => () => {}),
    requestTrash: vi.fn(),
    requestOpenFolder: vi.fn(() => true),
    openInVncApp: vi.fn(),
    linkWorkspaces: vi.fn(async () => {}),
    unlinkWorkspace: vi.fn(async () => {}),
    readTerminalText: vi.fn(async () => ({ text: '', bracketedPaste: false })),
    submitToTerminal: vi.fn(async () => {}),
    approveTerminalSend: vi.fn(async () => 'apply' as const),
    isTerminalRunning: () => true,
    onWorkspaceUpdated: () => () => {},
    onAttentionRaised: () => () => {},
    onPromptSubmitted: () => () => {},
    onTerminalOutput: () => () => {},
    onTerminalExit: () => () => {},
    onTerminalReset: () => () => {},
    notify: vi.fn(async () => {}),
    ...overrides,
  };
}

const projects = [
  { id: 'web', name: 'Web', kind: 'git' },
  { id: 'api', name: 'API', kind: 'git' },
  { id: 'notes', name: 'Notes', kind: 'directory' },
];

const workspaces = [
  { id: 'w-web', name: 'Web work', projectId: 'web', backend: { kind: 'local' as const } },
  {
    id: 'w-api',
    name: 'API work',
    projectId: 'api',
    backend: { kind: 'ssh' as const, hostId: 'box' },
  },
  { id: 'w-folder', name: 'Folder', projectId: null, backend: { kind: 'local' as const } },
];

function service(overrides: Partial<KomlaOperationDependencies> = {}) {
  const createWorkspace = vi.fn().mockResolvedValue({ id: 'w-new', branchName: 'new' });
  const instance = new KomlaOperationService(
    createDependencies({
      listProjects: () => projects,
      getProject: (id) => projects.find((project) => project.id === id),
      listWorkspaces: () => workspaces,
      createWorkspace,
      ...overrides,
    })
  );
  return { instance, createWorkspace };
}

describe('project.list', () => {
  it('lists every project, by id and name, with a schema the SDK shares', async () => {
    expect(parseKomlaOperation({ type: 'project.list' })).toEqual({ type: 'project.list' });
    const result = await service().instance.execute({}, { type: 'project.list' });

    expect(komlaOperationResultSchemas['project.list'].parse(result)).toEqual({
      projects: [
        { id: 'web', name: 'Web' },
        { id: 'api', name: 'API' },
        { id: 'notes', name: 'Notes' },
      ],
    });
  });

  it('lists only the allowed projects, and no folder project for a caller kept off this computer', async () => {
    const { instance } = service();

    await expect(
      instance.execute({ allowedProjectIds: ['api', 'notes'] }, { type: 'project.list' })
    ).resolves.toEqual({
      projects: [
        { id: 'api', name: 'API' },
        { id: 'notes', name: 'Notes' },
      ],
    });
    await expect(instance.execute({ sshOnly: true }, { type: 'project.list' })).resolves.toEqual({
      projects: [
        { id: 'web', name: 'Web' },
        { id: 'api', name: 'API' },
      ],
    });
  });
});

describe('a caller limited to some projects', () => {
  it('sees only those projects\' workspaces', async () => {
    const result = (await service().instance.execute(
      { allowedProjectIds: ['api'] },
      { type: 'workspace.list' }
    )) as { workspaces: Array<{ id: string }> };

    expect(result.workspaces.map(({ id }) => id)).toEqual(['w-api']);
  });

  it('starts a workspace in an allowed project', async () => {
    const { instance, createWorkspace } = service();

    await instance.execute(
      { allowedProjectIds: ['api'] },
      { type: 'agent.launch', destination: 'workspace', project: 'API', prompt: 'Fix it' }
    );

    expect(createWorkspace).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'api' }));
  });

  it("doesn't find any other project, and names only its own", async () => {
    const { instance, createWorkspace } = service();

    for (const project of ['Web', 'web', 'zzz']) {
      await expect(
        instance.execute(
          { allowedProjectIds: ['api'] },
          { type: 'agent.launch', destination: 'workspace', project }
        )
      ).rejects.toMatchObject({
        code: 'PROJECT_NOT_FOUND',
        statusCode: 404,
        details: { availableProjects: [{ id: 'api', name: 'API' }] },
      });
    }
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  it('is not told a name is ambiguous because of a project outside its scope', async () => {
    const twins = [
      { id: 'api', name: 'API', kind: 'git' },
      { id: 'api-2', name: 'API', kind: 'git' },
    ];
    const { instance, createWorkspace } = service({
      listProjects: () => twins,
      getProject: (id) => twins.find((project) => project.id === id),
    });

    await instance.execute(
      { allowedProjectIds: ['api'] },
      { type: 'agent.launch', destination: 'workspace', project: 'API' }
    );

    expect(createWorkspace).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'api' }));
  });

  it("refuses a project it reaches without naming one, without that project's name", async () => {
    const { instance } = service({
      resolveProjectByCwd: () => ({ project: projects[0] }),
    });

    await expect(
      instance.execute(
        { allowedProjectIds: ['api'], cwd: '/somewhere/web' },
        { type: 'agent.launch', destination: 'workspace' }
      )
    ).rejects.toMatchObject({
      code: 'PROJECT_NOT_ALLOWED',
      message: 'This caller may not start workspaces in that project.',
      details: { availableProjects: [{ id: 'api', name: 'API' }] },
    });
  });
});

describe('a caller kept off this computer', () => {
  it('sees only SSH workspaces', async () => {
    const result = (await service().instance.execute(
      { sshOnly: true },
      { type: 'workspace.list' }
    )) as { workspaces: Array<{ id: string }> };

    expect(result.workspaces.map(({ id }) => id)).toEqual(['w-api']);
  });

  it('hears no attention from a terminal on this computer', async () => {
    const attention = (terminalId: string) => ({
      kind: 'input-required' as const,
      source: 'hook',
      updatedAt: 1,
      terminalId,
    });
    const ssh = { kind: 'ssh' as const, hostId: 'box' };
    const { instance } = service({
      listWorkspaces: () => [
        {
          id: 'w-copy',
          name: 'Copy',
          projectId: 'api',
          backend: ssh,
          attention: attention('t-copy'),
          terminals: [{ id: 't-copy', executionLocation: 'local-copy' }],
        },
        {
          id: 'w-host',
          name: 'Host',
          projectId: 'api',
          backend: ssh,
          attention: attention('t-host'),
          terminals: [{ id: 't-host', executionLocation: 'remote' }],
        },
      ],
    });

    const result = (await instance.execute({ sshOnly: true }, { type: 'workspace.list' })) as {
      workspaces: Array<{ id: string; attention?: string }>;
    };

    expect(result.workspaces).toMatchObject([{ id: 'w-copy' }, { id: 'w-host', attention: 'input-required' }]);
    expect(result.workspaces[0]).not.toHaveProperty('attention');
  });

  it('refuses a launch that would start on this computer', async () => {
    const { instance, createWorkspace } = service();

    await expect(
      instance.execute(
        { sshOnly: true },
        { type: 'agent.launch', destination: 'workspace', project: 'Web' }
      )
    ).rejects.toMatchObject({ code: 'SSH_HOSTS_ONLY', statusCode: 403 });
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  it('starts one that goes to an SSH host', async () => {
    const { instance, createWorkspace } = service({
      getConfig: () => ({ agentLaunchDefaultSshHostId: 'box' }),
      listSshHosts: () => [{ id: 'box', name: 'Box' }],
    });

    await instance.execute(
      { sshOnly: true },
      { type: 'agent.launch', destination: 'workspace', project: 'Web' }
    );

    expect(createWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ environment: { kind: 'ssh', hostId: 'box' } })
    );
  });
});

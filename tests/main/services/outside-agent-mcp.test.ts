import { createServer, type Server } from 'http';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockElectron } from '../../mocks/electron';

import { KomlaOperationError } from '../../../src/main/services/komla-operation/operation';
import { handleOutsideAgentMcpRequest } from '../../../src/main/services/outside-agent-mcp';

import type { AgentTokenRecord } from '../../../src/main/services/agent-token.service';
import type {
  KomlaOperation,
  KomlaOperationContext,
} from '../../../src/main/services/komla-operation.service';

vi.mock('electron', () => mockElectron());

const TOKEN = `komla_agent_${'a'.repeat(43)}`;
const record: AgentTokenRecord = {
  id: 'token-1',
  label: 'Grok bot',
  projectIds: ['web'],
  sshOnly: false,
  createdAt: 0,
  expiresAt: Number.MAX_SAFE_INTEGER,
  tokenHash: '0'.repeat(64),
  approvedBy: { kind: 'passkey', credentialId: 'passkey-1' },
};

describe('the Outside Agent MCP route', () => {
  let server: Server;
  let url: string;
  let localAccess: boolean;
  let tokenSshOnly: boolean;
  let calls: Array<{
    context: KomlaOperationContext;
    operation: KomlaOperation;
  }>;
  let results: Partial<Record<KomlaOperation['type'], unknown>>;

  beforeEach(async () => {
    localAccess = true;
    tokenSshOnly = false;
    calls = [];
    results = {
      'project.list': { projects: [{ id: 'web', name: 'Web' }] },
      'workspace.list': {
        workspaces: [
          {
            id: 'w-1',
            name: 'Login fix',
            project: { id: 'web', name: 'Web' },
            branch: 'fix-login',
            path: '/secret/path',
            environment: { kind: 'ssh', hostId: 'box' },
            agentActive: false,
            attention: 'turn-complete',
          },
        ],
      },
      'agent.launch': {
        state: 'started',
        destination: {
          kind: 'workspace',
          workspaceId: 'w-2',
          branch: 'fix-login',
        },
        agent: { preset: { id: 'claude', name: 'Claude Code' } },
      },
    };
    server = createServer((req, res) =>
      handleOutsideAgentMcpRequest(req, res, {
        authenticate: (bearer) => (bearer === TOKEN ? { ...record, sshOnly: tokenSshOnly } : null),
        getConfig: () => ({ directRemoteLocalAccess: localAccess }),
        execute: async (context, operation) => {
          calls.push({ context, operation });
          if (operation.type === 'agent.launch' && operation.project === 'API') {
            throw new KomlaOperationError(
              'PROJECT_NOT_FOUND',
              'Project "API" was not found.',
              404,
              {
                availableProjects: [{ id: 'web', name: 'Web' }],
              }
            );
          }
          if (operation.type === 'agent.launch' && operation.project === 'Broken') {
            throw new Error("fatal: could not create work tree dir '/Users/me/.komla/worktrees/x'");
          }
          return results[operation.type] as never;
        },
      })
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    url = `http://127.0.0.1:${address.port}/remote/mcp`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function connect(token = TOKEN) {
    const client = new Client({ name: 'test-bot', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      })
    );
    return client;
  }

  function text(result: Awaited<ReturnType<Client['callTool']>>) {
    return (result.content as Array<{ text: string }>)[0].text;
  }

  it('offers only the tools for starting and following workspaces', async () => {
    const client = await connect();
    const { tools } = await client.listTools();

    expect(tools.map(({ name }) => name).sort()).toEqual([
      'launch_workspace',
      'list_projects',
      'list_workspaces',
      'workspace_status',
    ]);
    await client.close();
  });

  it("runs each operation with the token's projects as the caller's only ones", async () => {
    const client = await connect();

    const result = await client.callTool({
      name: 'launch_workspace',
      arguments: {
        project: 'Web',
        prompt: 'Fix the login test',
        agent: 'Claude Code',
      },
    });

    expect(JSON.parse(text(result))).toEqual({
      state: 'started',
      workspaceId: 'w-2',
      branch: 'fix-login',
      agent: 'Claude Code',
    });
    expect(calls).toEqual([
      {
        context: { allowedProjectIds: ['web'], sshOnly: false },
        operation: {
          type: 'agent.launch',
          destination: 'workspace',
          project: 'Web',
          prompt: 'Fix the login test',
          preset: 'Claude Code',
        },
      },
    ]);
    await client.close();
  });

  it('keeps the caller off this computer while remote access to it is off', async () => {
    localAccess = false;
    const client = await connect();

    await client.callTool({ name: 'list_projects', arguments: {} });

    expect(calls[0].context).toEqual({
      allowedProjectIds: ['web'],
      sshOnly: true,
    });
    await client.close();
  });

  it('keeps a token approved for SSH hosts only off this computer, though devices may reach it', async () => {
    tokenSshOnly = true;
    const client = await connect();

    await client.callTool({ name: 'list_projects', arguments: {} });

    expect(calls[0].context).toEqual({
      allowedProjectIds: ['web'],
      sshOnly: true,
    });
    await client.close();
  });

  it("lists workspaces without the paths on this computer, and finds one's status", async () => {
    const client = await connect();

    const list = JSON.parse(
      text(await client.callTool({ name: 'list_workspaces', arguments: {} }))
    );
    expect(list).toEqual([
      {
        id: 'w-1',
        name: 'Login fix',
        project: 'Web',
        branch: 'fix-login',
        environment: 'ssh',
        agentActive: false,
        attention: 'turn-complete',
      },
    ]);

    const status = await client.callTool({
      name: 'workspace_status',
      arguments: { workspaceId: 'w-1' },
    });
    expect(JSON.parse(text(status))).toMatchObject({
      id: 'w-1',
      attention: 'turn-complete',
    });
    // A workspace in the Trash still has a status.
    expect(calls.at(-1)?.operation).toEqual({
      type: 'workspace.list',
      includeTrashed: true,
    });

    const missing = await client.callTool({
      name: 'workspace_status',
      arguments: { workspaceId: 'w-9' },
    });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toBe('Error: No workspace in your projects has the id w-9.');
    await client.close();
  });

  it('reports a refused operation with the projects the token may use', async () => {
    const client = await connect();

    const result = await client.callTool({
      name: 'launch_workspace',
      arguments: { project: 'API', prompt: 'x' },
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toBe('Error: Project "API" was not found.\nYour projects: Web');
    await client.close();
  });

  it("keeps an unexpected failure's details on this computer", async () => {
    const client = await connect();

    const result = await client.callTool({
      name: 'launch_workspace',
      arguments: { project: 'Broken', prompt: 'x' },
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toBe('Error: Komla could not complete the operation.');
    await client.close();
  });

  it('takes the auth scheme in any case', async () => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `bearer ${TOKEN}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    expect(response.status).toBe(200);
  });

  it('answers 401 without a token, or with one it does not know', async () => {
    const missing = await fetch(url, { method: 'POST', body: '{}' });
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toBe('Bearer realm="komla"');

    const wrong = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer komla_agent_${'b'.repeat(43)}` },
      body: '{}',
    });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('www-authenticate')).toBe(
      'Bearer realm="komla", error="invalid_token"'
    );
    await expect(connect(`komla_agent_${'b'.repeat(43)}`)).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('refuses requests a browser sends for a page, even with a valid token', async () => {
    for (const headers of [
      { Origin: 'https://evil.example' },
      { 'Sec-Fetch-Site': 'cross-site' },
    ]) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, ...headers },
        body: '{}',
      });
      expect(response.status).toBe(403);
    }
    expect(calls).toEqual([]);
  });

  it('opens no stream: GET is not allowed', async () => {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    expect(response.status).toBe(405);
  });
});

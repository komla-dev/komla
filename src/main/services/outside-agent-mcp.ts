// MCP for Outside Agents, served on remote control's server at `/remote/mcp` (ADR 0013).
//
// An Outside Agent runs off this computer, on the user's tailnet, and calls with the Agent Token
// the user approved. It can list the token's projects and their workspaces and start workspaces
// in them; Komla Operations apply every rule, with the token's projects as the caller's only ones.
// Nothing here opens, reads or types into a terminal.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import { createLogger } from '../lib/logger';

import { KomlaOperationError } from './komla-operation/operation';
import { remoteLocalAccessAllowed } from './remote-control-local-access';

import type { AgentTokenRecord } from './agent-token.service';
import type {
  KomlaOperation,
  KomlaOperationContext,
  KomlaOperationResult,
} from './komla-operation.service';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { IncomingMessage, ServerResponse } from 'http';

const logger = createLogger('OutsideAgentMcp');

export interface OutsideAgentMcpDeps {
  authenticate(bearer: string): AgentTokenRecord | null;
  getConfig(): { directRemoteLocalAccess?: boolean };
  execute<T extends KomlaOperation>(
    context: KomlaOperationContext,
    operation: T
  ): Promise<KomlaOperationResult<T['type']>>;
}

/** Answers one request to `/remote/mcp`. */
export function handleOutsideAgentMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: OutsideAgentMcpDeps
): void {
  // Browsers send these for pages; MCP clients don't. A page on the tailnet must not use a token
  // the browser can't hold anyway, nor learn whether Komla answers.
  const fetchSite = header(req, 'sec-fetch-site');
  if (header(req, 'origin') !== undefined || (fetchSite !== undefined && fetchSite !== 'none')) {
    sendJson(res, 403, { error: 'Browser requests are not accepted.' });
    return;
  }
  // An auth scheme's name is case-insensitive (RFC 9110).
  const bearer = /^Bearer\s+(\S+)$/i.exec(header(req, 'authorization') ?? '')?.[1];
  const token = bearer ? deps.authenticate(bearer) : null;
  if (!token) {
    res.setHeader(
      'WWW-Authenticate',
      bearer ? 'Bearer realm="komla", error="invalid_token"' : 'Bearer realm="komla"'
    );
    sendJson(res, 401, {
      error: bearer
        ? 'This agent token is not valid: it expired or was revoked.'
        : 'Send an agent token as "Authorization: Bearer <token>". Make one on the remote control page under Settings › Agent access.',
    });
    return;
  }
  if (req.method !== 'POST') {
    // The endpoint is stateless: there is no stream to open and no session to end.
    res.setHeader('Allow', 'POST');
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }

  const context: KomlaOperationContext = {
    allowedProjectIds: token.projectIds,
    // A token approved for SSH hosts only stays off this computer even while devices may reach it.
    sshOnly: token.sshOnly || !remoteLocalAccessAllowed(deps.getConfig()),
  };
  const server = createOutsideAgentMcpServer(context, deps);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  res.on('close', () => void server.close());
  server
    .connect(transport)
    .then(() => transport.handleRequest(req, res))
    .catch((error) => {
      logger.error('outside agent MCP request failed', error);
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' });
    });
}

export function createOutsideAgentMcpServer(
  context: KomlaOperationContext,
  deps: Pick<OutsideAgentMcpDeps, 'execute'>
): McpServer {
  const server = new McpServer({ name: 'komla', version: '1.0.0' });
  const run = <T extends KomlaOperation>(
    operation: T,
    render: (result: KomlaOperationResult<T['type']>) => unknown
  ): Promise<CallToolResult> => execute(deps, context, operation, render);

  server.tool(
    'list_projects',
    'List the Komla projects you may start workspaces in, by id and name.',
    {},
    () => run({ type: 'project.list' }, (result) => result)
  );

  server.tool(
    'list_workspaces',
    "List the Komla workspaces in your projects: each one's id, name, project, branch, whether its agent is working, and the attention it shows, such as input-required when its agent waits for the user.",
    {
      includeTrashed: z.boolean().optional().describe('Also list workspaces in the Trash.'),
    },
    ({ includeTrashed }) =>
      run(
        {
          type: 'workspace.list',
          ...(includeTrashed ? { includeTrashed } : {}),
        },
        (result) => result.workspaces.map(workspaceSummary)
      )
  );

  server.tool(
    'launch_workspace',
    "Start an AI coding agent in a new Komla workspace: its own branch and working directory, branched from the project's base branch, with your prompt as its first message. The user sees it in Komla and can steer it there.",
    {
      project: z.string().min(1).describe('The project, by an id or name list_projects gives.'),
      prompt: z
        .string()
        .min(1)
        .max(64 * 1024)
        .describe('The task for the agent.'),
      name: z.string().min(1).max(256).optional().describe('A 2-3 word title for the workspace.'),
      description: z.string().min(1).max(1024).optional().describe('One sentence summary.'),
      branch: z
        .string()
        .min(1)
        .max(256)
        .optional()
        .describe(
          'A branch name, such as "fix-login-redirect". Komla names one otherwise. When the SSH host already has the name, a number goes on its end: workspace_status gives the branch the workspace got.'
        ),
      agent: z
        .string()
        .min(1)
        .optional()
        .describe("The agent to start, by name, such as Claude Code. Without it, the user's pick."),
      mode: z
        .string()
        .min(1)
        .optional()
        .describe(
          "One of that agent's launch modes, by name. Only modes the user lets agents start work."
        ),
    },
    ({ project, prompt, name, description, branch, agent, mode }) =>
      run(
        {
          type: 'agent.launch',
          destination: 'workspace',
          project,
          prompt,
          ...(name ? { name } : {}),
          ...(description ? { description } : {}),
          ...(branch ? { branch } : {}),
          ...(agent ? { preset: agent } : {}),
          ...(mode ? { mode } : {}),
        },
        ({ state, destination, agent: started }) => ({
          state,
          ...(destination.kind === 'workspace'
            ? {
                workspaceId: destination.workspaceId,
                ...(destination.branch ? { branch: destination.branch } : {}),
              }
            : {}),
          ...(started ? { agent: started.preset.name } : {}),
          ...(started?.mode ? { mode: started.mode.name } : {}),
        })
      )
  );

  server.tool(
    'workspace_status',
    "One workspace's state, as list_workspaces gives it: whether its agent is working, and the attention it shows, such as turn-complete once its agent finished.",
    {
      workspaceId: z.string().min(1).describe('The id launch_workspace or list_workspaces gave.'),
    },
    ({ workspaceId }) =>
      // A workspace the user trashed says so, rather than seeming never to have existed.
      run({ type: 'workspace.list', includeTrashed: true }, (list) => {
        const workspace = list.workspaces.find((candidate) => candidate.id === workspaceId);
        if (!workspace) {
          throw new KomlaOperationError(
            'WORKSPACE_NOT_FOUND',
            `No workspace in your projects has the id ${workspaceId}.`,
            404
          );
        }
        return workspaceSummary(workspace);
      })
  );

  return server;
}

type WorkspaceListEntry = KomlaOperationResult<'workspace.list'>['workspaces'][number];

function workspaceSummary(workspace: WorkspaceListEntry) {
  return {
    id: workspace.id,
    name: workspace.name,
    ...(workspace.project ? { project: workspace.project.name } : {}),
    ...(workspace.branch ? { branch: workspace.branch } : {}),
    environment: workspace.environment.kind,
    agentActive: workspace.agentActive,
    ...(workspace.attention ? { attention: workspace.attention } : {}),
    ...(workspace.tag ? { tag: workspace.tag } : {}),
    ...(workspace.progress ? { progress: workspace.progress } : {}),
    ...(workspace.trashed ? { trashed: true } : {}),
  };
}

async function execute<T extends KomlaOperation>(
  deps: Pick<OutsideAgentMcpDeps, 'execute'>,
  context: KomlaOperationContext,
  operation: T,
  render: (result: KomlaOperationResult<T['type']>) => unknown
): Promise<CallToolResult> {
  try {
    const result = await deps.execute(context, operation);
    return withValue(render(result));
  } catch (error) {
    // Only an operation's own refusals are written for the caller; anything else can carry paths
    // or host names from this computer.
    if (!(error instanceof KomlaOperationError)) {
      logger.error('outside agent operation failed', {
        type: operation.type,
        error: error instanceof Error ? error.message : String(error),
      });
      return errorResult('Komla could not complete the operation.');
    }
    const message = error.message;
    const details = error.details as { availableProjects?: unknown } | undefined;
    const projects = Array.isArray(details?.availableProjects)
      ? `\nYour projects: ${details.availableProjects
          .map((project) => (project as { name?: string }).name)
          .filter(Boolean)
          .join(', ')}`
      : '';
    return errorResult(`${message}${projects}`);
  }
}

/** The value as JSON text, and as structured content for clients that read it. */
function withValue(value: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value ?? null, null, 2) }],
    structuredContent: { value },
  };
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text: `Error: ${text}` }], isError: true };
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

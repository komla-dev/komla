/**
 * @vitest-environment jsdom
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  agentTokenDetail,
  RemoteAgentTokensCard,
} from '../../../../../src/renderer/components/layout/settings/RemoteAgentTokensCard';
import { TooltipProvider } from '../../../../../src/renderer/components/ui/tooltip';

import type { AgentTokenSummary } from '../../../../../src/shared/types/agent-token';

const mockAddToast = vi.fn();
const mockConfig: { agentLaunchDefaultSshHostId?: string } = { agentLaunchDefaultSshHostId: 'box' };

vi.mock('../../../../../src/renderer/stores/config.store', () => ({
  useConfigStore: (selector: (state: { config: typeof mockConfig }) => unknown) =>
    selector({ config: mockConfig }),
}));

vi.mock('../../../../../src/renderer/stores/toast.store', () => ({
  useToastStore: (selector: (state: { addToast: typeof mockAddToast }) => unknown) =>
    selector({ addToast: mockAddToast }),
}));

const mockProjects = vi.hoisted(() => ({
  list: [] as Array<{ id: string; name: string }>,
}));

vi.mock('../../../../../src/renderer/stores/projects.store', () => ({
  useProjectsStore: (
    selector: (state: { projects: Array<{ id: string; name: string }> }) => unknown
  ) => selector({ projects: mockProjects.list }),
}));

const DAY_MS = 24 * 60 * 60_000;
const now = Date.now();
const token: AgentTokenSummary = {
  id: 'tok-1',
  label: 'Grok bot',
  projectIds: ['web', 'gone'],
  sshOnly: true,
  createdAt: now,
  expiresAt: now + 30 * DAY_MS,
};

const SECRET = `komla_agent_${'S'.repeat(43)}`;
const MCP_URL = 'https://mac.tail1.ts.net/remote/mcp';
const HOST_MCP = { hostName: 'devbox', url: 'https://devbox.tail1.ts.net:48123/remote/mcp' };

function card(props: Partial<Parameters<typeof RemoteAgentTokensCard>[0]> = {}) {
  return render(
    <TooltipProvider>
      <RemoteAgentTokensCard mcpUrl={MCP_URL} remoteOn localAccess {...props} />
    </TooltipProvider>
  );
}

function installApi(list: AgentTokenSummary[]) {
  let changed: ((next: AgentTokenSummary[]) => void) | null = null;
  const api = {
    agentTokensList: vi.fn().mockResolvedValue(list),
    agentTokensRevoke: vi.fn().mockResolvedValue(undefined),
    agentTokensCreate: vi.fn().mockResolvedValue({ token: SECRET, summary: token }),
    onAgentTokensChanged: vi.fn((callback: (next: AgentTokenSummary[]) => void) => {
      changed = callback;
      return vi.fn();
    }),
    copyToClipboard: vi.fn(),
  };
  Object.defineProperty(window, 'api', { value: api, configurable: true });
  return { api, emitChange: (next: AgentTokenSummary[]) => changed?.(next) };
}

describe('RemoteAgentTokensCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.agentLaunchDefaultSshHostId = 'box';
    mockProjects.list = [
      { id: 'web', name: 'Web' },
      { id: 'api', name: 'API' },
    ];
  });

  it("warns that an SSH-only token can't start anything while agents start on this computer", async () => {
    const STUCK = /can't start workspaces until you pick an SSH host under Where agents start/;
    installApi([token]);
    const first = card();
    expect(await screen.findByText('Grok bot')).toBeTruthy();
    expect(screen.queryByText(STUCK)).toBeNull();
    first.unmount();

    mockConfig.agentLaunchDefaultSshHostId = undefined;
    card();
    expect(await screen.findByText(STUCK)).toBeTruthy();
  });

  it('offers to add an agent while remote control is on, even before any token exists', async () => {
    const { api } = installApi([]);

    card();

    await waitFor(() => expect(api.agentTokensList).toHaveBeenCalled());
    expect(screen.getByText('Agent access')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add an agent' })).toBeTruthy();
    expect(screen.getByText('No agents yet')).toBeTruthy();
  });

  it('shows nothing while remote control is off', async () => {
    const { api } = installApi([]);

    const { container } = card({ remoteOn: false, mcpUrl: null });

    await waitFor(() => expect(api.agentTokensList).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('approves an Agent Token on the desktop and shows it once', async () => {
    const { api } = installApi([]);
    card();

    await userEvent.click(screen.getByRole('button', { name: 'Add an agent' }));
    const approve = screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);

    await userEvent.type(screen.getByLabelText('Name'), '  Desk bot ');
    await userEvent.click(screen.getByLabelText('API'));
    // Stricter choices first: SSH hosts only, for 30 days.
    const where = screen.getByLabelText('Where') as HTMLSelectElement;
    const lifetime = screen.getByLabelText('Works for') as HTMLSelectElement;
    expect(where.value).toBe('ssh');
    expect(lifetime.value).toBe('30');
    expect([...lifetime.options].map((option) => option.text)).toEqual([
      '7 days',
      '30 days',
      '90 days',
      'Never expires',
    ]);
    expect(screen.queryByText(/Anyone who copies this token/)).toBeNull();
    await userEvent.selectOptions(lifetime, 'never');
    expect(screen.getByText(/Anyone who copies this token/)).toBeTruthy();
    await userEvent.selectOptions(where, 'anywhere');

    await userEvent.click(approve);
    expect(api.agentTokensCreate).toHaveBeenCalledWith({
      label: 'Desk bot',
      projectIds: ['api'],
      lifetimeDays: null,
      sshOnly: false,
    });

    expect(await screen.findByText(SECRET)).toBeTruthy();
    expect(screen.getByText(/won't show it again/)).toBeTruthy();
    expect(screen.getByText(MCP_URL)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Copy token' }));
    expect(api.copyToClipboard).toHaveBeenCalledWith(SECRET);

    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText(SECRET)).toBeNull();
    expect(screen.getByRole('button', { name: 'Add an agent' })).toBeTruthy();
  });

  it('keeps the agent off this computer while "Allow access to this computer" is off', async () => {
    const { api } = installApi([]);
    card({ localAccess: false });

    await userEvent.click(screen.getByRole('button', { name: 'Add an agent' }));
    expect(screen.queryByLabelText('Where')).toBeNull();
    await userEvent.type(screen.getByLabelText('Name'), 'Desk bot');
    await userEvent.click(screen.getByLabelText('Web'));
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));

    expect(api.agentTokensCreate).toHaveBeenCalledWith(
      expect.objectContaining({ sshOnly: true, lifetimeDays: 30, projectIds: ['web'] })
    );
  });

  it('says why the desktop refused the token, and keeps the form', async () => {
    const { api } = installApi([]);
    // ipcRenderer.invoke wraps what the main process threw.
    api.agentTokensCreate.mockRejectedValue(
      new Error(
        "Error invoking remote method 'agent-tokens:create': Error: One of those projects no longer exists."
      )
    );
    card();

    await userEvent.click(screen.getByRole('button', { name: 'Add an agent' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Desk bot');
    await userEvent.click(screen.getByLabelText('Web'));
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));

    expect(await screen.findByText('One of those projects no longer exists.')).toBeTruthy();
    expect(screen.getByLabelText('Name')).toBeTruthy();
  });

  it("lists each token with its projects, and revokes one once it's confirmed", async () => {
    const { api, emitChange } = installApi([token]);
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    card();

    expect(await screen.findByText('Grok bot')).toBeTruthy();
    expect(
      screen.getByText(/Web, Removed project · SSH hosts only · Expires in 30 days · Never used/)
    ).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Copy MCP address' }));
    expect(api.copyToClipboard).toHaveBeenCalledWith(MCP_URL);

    await userEvent.click(screen.getByRole('button', { name: 'Revoke Grok bot' }));
    expect(api.agentTokensRevoke).toHaveBeenCalledWith('tok-1');

    emitChange([]);
    await waitFor(() => expect(screen.queryByText('Grok bot')).toBeNull());
  });

  it("gives a token limited to SSH hosts the host's own address, which works while this computer is off", async () => {
    const { api } = installApi([]);
    card({ hostMcp: HOST_MCP });

    await userEvent.click(screen.getByRole('button', { name: 'Add an agent' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Desk bot');
    await userEvent.click(screen.getByLabelText('Web'));
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));

    expect(await screen.findByText(HOST_MCP.url)).toBeTruthy();
    expect(screen.getByText(/works while this computer is off/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Copy MCP address' }));
    expect(api.copyToClipboard).toHaveBeenCalledWith(HOST_MCP.url);
    expect(screen.queryByText(MCP_URL)).toBeNull();
  });

  it("gives a token that may reach this computer this computer's address", async () => {
    const { api } = installApi([]);
    api.agentTokensCreate.mockResolvedValue({
      token: SECRET,
      summary: { ...token, sshOnly: false },
    });
    card({ hostMcp: HOST_MCP });

    await userEvent.click(screen.getByRole('button', { name: 'Add an agent' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Desk bot');
    await userEvent.click(screen.getByLabelText('Web'));
    await userEvent.selectOptions(screen.getByLabelText('Where'), 'anywhere');
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));

    expect(await screen.findByText(MCP_URL)).toBeTruthy();
    expect(screen.queryByText(HOST_MCP.url)).toBeNull();
  });

  it('lists the host address too, and says a revoke reaches the host when Komla next connects', async () => {
    const { api } = installApi([token]);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    card({ hostMcp: HOST_MCP });

    expect(await screen.findByText(HOST_MCP.url)).toBeTruthy();
    expect(screen.getByText(MCP_URL)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Revoke Grok bot' }));

    expect(confirm).toHaveBeenCalledWith(
      expect.stringMatching(/devbox stops taking it the next time Komla connects to it/)
    );
    expect(api.agentTokensRevoke).toHaveBeenCalledWith('tok-1');
  });

  it('warns in the form when an SSH-only token could start nothing yet', async () => {
    const STUCK = /can't start workspaces until you pick an SSH host under Where agents start/;
    mockConfig.agentLaunchDefaultSshHostId = undefined;
    installApi([]);
    card();

    await userEvent.click(screen.getByRole('button', { name: 'Add an agent' }));
    expect(screen.getByText(STUCK)).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText('Where'), 'anywhere');
    expect(screen.queryByText(STUCK)).toBeNull();
  });

  it('forgets a token it showed once remote control turns off', async () => {
    installApi([]);
    const view = card();
    await userEvent.click(screen.getByRole('button', { name: 'Add an agent' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Desk bot');
    await userEvent.click(screen.getByLabelText('Web'));
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText(SECRET)).toBeTruthy();

    // Turning remote control off revoked it, so it must not come back when it turns on again.
    view.rerender(
      <TooltipProvider>
        <RemoteAgentTokensCard mcpUrl={null} remoteOn={false} localAccess />
      </TooltipProvider>
    );
    view.rerender(
      <TooltipProvider>
        <RemoteAgentTokensCard mcpUrl={MCP_URL} remoteOn localAccess />
      </TooltipProvider>
    );

    expect(screen.queryByText(SECRET)).toBeNull();
    expect(screen.getByRole('button', { name: 'Add an agent' })).toBeTruthy();
  });

  it("won't approve once every project it picked is gone", async () => {
    mockProjects.list = [{ id: 'web', name: 'Web' }];
    installApi([]);
    const view = card();
    await userEvent.click(screen.getByRole('button', { name: 'Add an agent' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Desk bot');
    // The only project starts ticked.
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(
      false
    );

    mockProjects.list = [{ id: 'api', name: 'API' }];
    view.rerender(
      <TooltipProvider>
        <RemoteAgentTokensCard mcpUrl={MCP_URL} remoteOn localAccess />
      </TooltipProvider>
    );

    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it('says when a token expires and when it was last used', () => {
    expect(agentTokenDetail({ ...token, expiresAt: now + DAY_MS / 2 }, now)).toBe(
      'SSH hosts only · Expires in 1 day · Never used'
    );
    expect(agentTokenDetail({ ...token, expiresAt: now }, now)).toBe('SSH hosts only · Expired');
    expect(agentTokenDetail({ ...token, expiresAt: null }, now)).toBe(
      'SSH hosts only · Never expires · Never used'
    );
    expect(agentTokenDetail({ ...token, sshOnly: false, lastUsedAt: now }, now)).toMatch(
      /^SSH hosts and this computer · Expires in 30 days · Last used /
    );
  });
});

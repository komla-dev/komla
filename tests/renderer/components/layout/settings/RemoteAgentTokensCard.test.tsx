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

vi.mock('../../../../../src/renderer/stores/projects.store', () => ({
  useProjectsStore: (
    selector: (state: { projects: Array<{ id: string; name: string }> }) => unknown
  ) => selector({ projects: [{ id: 'web', name: 'Web' }] }),
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

function installApi(list: AgentTokenSummary[]) {
  let changed: ((next: AgentTokenSummary[]) => void) | null = null;
  const api = {
    agentTokensList: vi.fn().mockResolvedValue(list),
    agentTokensRevoke: vi.fn().mockResolvedValue(undefined),
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
  });

  it("warns that an SSH-only token can't start anything while agents start on this computer", async () => {
    const STUCK = /can't start workspaces until you pick an SSH host under Where agents start/;
    installApi([token]);
    const card = () =>
      render(
        <TooltipProvider>
          <RemoteAgentTokensCard mcpUrl={null} />
        </TooltipProvider>
      );

    const first = card();
    expect(await screen.findByText('Grok bot')).toBeTruthy();
    expect(screen.queryByText(STUCK)).toBeNull();
    first.unmount();

    mockConfig.agentLaunchDefaultSshHostId = undefined;
    card();
    expect(await screen.findByText(STUCK)).toBeTruthy();
  });

  it('shows nothing until an Outside Agent has a token', async () => {
    const { api } = installApi([]);

    const { container } = render(<RemoteAgentTokensCard mcpUrl={null} />);

    await waitFor(() => expect(api.agentTokensList).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it("lists each token with its projects, and revokes one once it's confirmed", async () => {
    const { api, emitChange } = installApi([token]);
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(
      <TooltipProvider>
        <RemoteAgentTokensCard mcpUrl="https://box.tail1.ts.net/remote/mcp" />
      </TooltipProvider>
    );

    expect(await screen.findByText('Grok bot')).toBeTruthy();
    expect(
      screen.getByText(/Web, Removed project · SSH hosts only · Expires in 30 days · Never used/)
    ).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Copy MCP address' }));
    expect(api.copyToClipboard).toHaveBeenCalledWith('https://box.tail1.ts.net/remote/mcp');

    await userEvent.click(screen.getByRole('button', { name: 'Revoke Grok bot' }));
    expect(api.agentTokensRevoke).toHaveBeenCalledWith('tok-1');

    emitChange([]);
    await waitFor(() => expect(screen.queryByText('Grok bot')).toBeNull());
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

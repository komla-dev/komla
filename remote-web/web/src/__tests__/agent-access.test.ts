// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentAccessPanel, agentTokenDetail, type AgentAccessDeps } from '../agent-access';

import type { RemoteAgentTokenSummary } from '@komla/remote-protocol';

const html = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'index.html'),
  'utf8'
);
const DAY_MS = 24 * 60 * 60_000;
const NOW = 1_700_000_000_000;
const TOKEN = `komla_agent_${'A'.repeat(43)}`;

const summary: RemoteAgentTokenSummary = {
  id: 'tok-1',
  label: 'Grok bot',
  projectIds: ['web'],
  sshOnly: true,
  createdAt: NOW,
  expiresAt: NOW + 30 * DAY_MS,
};

function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function setup(projects = [{ id: 'web', name: 'Web', repositoryPath: '/r/web' }]) {
  document.body.innerHTML = html.slice(html.indexOf('<body'), html.indexOf('</body>'));
  const sent: unknown[] = [];
  let next = 0;
  const deps: AgentAccessDeps = {
    send: vi.fn((frame) => {
      sent.push(frame);
      return `r${++next}`;
    }),
    projects: () => projects,
    origin: () => 'https://box.tail1.ts.net',
    copy: vi.fn(async () => {}),
    confirm: vi.fn(() => true),
    now: () => NOW,
  };
  const panel = new AgentAccessPanel(
    {
      section: byId('agent-access'),
      list: byId('agent-token-list'),
      add: byId('agent-token-add'),
      form: byId('agent-token-form'),
      label: byId('agent-token-label'),
      projects: byId('agent-token-projects'),
      lifetime: byId('agent-token-lifetime'),
      neverWarning: byId('agent-token-never-warning'),
      where: byId('agent-token-where'),
      approve: byId('agent-token-approve'),
      cancel: byId('agent-token-cancel'),
      created: byId('agent-token-created'),
      token: byId('agent-token-value'),
      copyToken: byId('agent-token-copy'),
      mcpUrl: byId('agent-mcp-url'),
      copyMcpUrl: byId('agent-mcp-url-copy'),
      done: byId('agent-token-done'),
      hint: byId('agent-token-hint'),
    },
    deps
  );
  return { panel, sent, deps };
}

describe('Agent access', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('shows only while connected to the desktop, which it asks for its tokens', () => {
    const { panel, sent } = setup();

    panel.connected(false);
    expect(byId('agent-access').hidden).toBe(true);
    expect(sent).toEqual([]);

    panel.connected(true);
    expect(byId('agent-access').hidden).toBe(false);
    expect(sent).toEqual([{ type: 'app:agent-tokens:list' }]);
  });

  it('approves a token for the chosen projects and shows it once, with the address to call', () => {
    const { panel, sent, deps } = setup([
      { id: 'web', name: 'Web', repositoryPath: '/r/web' },
      { id: 'api', name: 'API', repositoryPath: '/r/api' },
    ]);
    panel.connected(true);

    byId<HTMLButtonElement>('agent-token-add').click();
    const approve = byId<HTMLButtonElement>('agent-token-approve');
    expect(approve.disabled).toBe(true);
    byId<HTMLInputElement>('agent-token-label').value = 'Grok bot';
    byId('agent-token-projects').querySelector<HTMLInputElement>('input[value="api"]')!.checked =
      true;
    byId('agent-token-form').dispatchEvent(new Event('input'));
    expect(approve.disabled).toBe(false);
    byId<HTMLSelectElement>('agent-token-lifetime').value = '7';
    byId('agent-token-form').dispatchEvent(new Event('submit', { cancelable: true }));

    expect(sent.at(-1)).toEqual({
      type: 'app:agent-token:create',
      label: 'Grok bot',
      projectIds: ['api'],
      lifetimeDays: 7,
      // The stricter choice unless the user picks otherwise.
      sshOnly: true,
    });

    panel.handleFrame({
      type: 'app:agent-token:created',
      requestId: 'r2',
      token: TOKEN,
      summary: { ...summary, projectIds: ['api'] },
    });
    expect(byId('agent-token-created').hidden).toBe(false);
    expect(byId('agent-token-value').textContent).toBe(TOKEN);
    expect(byId('agent-mcp-url').textContent).toBe('https://box.tail1.ts.net/remote/mcp');
    expect(byId('agent-token-list').textContent).toContain('API · SSH hosts only · Expires in 30 days');

    byId<HTMLButtonElement>('agent-token-copy').click();
    expect(deps.copy).toHaveBeenCalledWith(TOKEN);

    byId<HTMLButtonElement>('agent-token-done').click();
    expect(byId('agent-token-value').textContent).toBe('');
    expect(byId('agent-token-created').hidden).toBe(true);
  });

  it('lets go of a request a reconnect left unanswered, and asks for the list again', () => {
    const { panel, sent } = setup();
    panel.connected(true);
    panel.handleFrame({ type: 'app:agent-tokens', requestId: 'r1', tokens: [summary] });
    byId('agent-token-list').querySelector<HTMLButtonElement>('button')!.click();
    expect(byId('agent-token-list').querySelector<HTMLButtonElement>('button')!.disabled).toBe(
      true
    );

    panel.connected(true);

    expect(sent.at(-1)).toEqual({ type: 'app:agent-tokens:list' });
    expect(byId('agent-token-list').querySelector<HTMLButtonElement>('button')!.disabled).toBe(
      false
    );
  });

  it('asks for the list again when Settings opens, as another device may have changed it', () => {
    const { panel, sent } = setup();
    panel.connected(true);

    panel.refresh();

    expect(sent).toEqual([{ type: 'app:agent-tokens:list' }, { type: 'app:agent-tokens:list' }]);
  });

  it('lets this computer in only when the user picks it, and starts each new token at SSH only', () => {
    const { panel, sent } = setup();
    panel.connected(true);
    byId<HTMLButtonElement>('agent-token-add').click();
    byId<HTMLInputElement>('agent-token-label').value = 'Laptop bot';
    byId<HTMLSelectElement>('agent-token-where').value = 'anywhere';
    byId('agent-token-form').dispatchEvent(new Event('submit', { cancelable: true }));

    expect(sent.at(-1)).toMatchObject({ type: 'app:agent-token:create', sshOnly: false });

    byId<HTMLButtonElement>('agent-token-cancel').click();
    byId<HTMLButtonElement>('agent-token-add').click();
    expect(byId<HTMLSelectElement>('agent-token-where').value).toBe('ssh');
  });

  it('warns only while the token would never expire, and asks for one that works until revoked', () => {
    const { panel, sent } = setup();
    panel.connected(true);
    byId<HTMLButtonElement>('agent-token-add').click();
    const warning = byId('agent-token-never-warning');
    expect(warning.hidden).toBe(true);

    byId<HTMLInputElement>('agent-token-label').value = 'Grok bot';
    byId<HTMLSelectElement>('agent-token-lifetime').value = 'never';
    byId('agent-token-form').dispatchEvent(new Event('input'));
    expect(warning.hidden).toBe(false);
    byId('agent-token-form').dispatchEvent(new Event('submit', { cancelable: true }));
    expect(sent.at(-1)).toMatchObject({ type: 'app:agent-token:create', lifetimeDays: null });

    // The next token starts at 30 days again, without the warning.
    byId<HTMLButtonElement>('agent-token-cancel').click();
    byId<HTMLButtonElement>('agent-token-add').click();
    expect(byId<HTMLSelectElement>('agent-token-lifetime').value).toBe('30');
    expect(warning.hidden).toBe(true);
    expect(agentTokenDetail({ ...summary, expiresAt: null }, NOW)).toBe(
      'SSH hosts only · Never expires · never used'
    );
  });

  it('revokes a token once confirmed', () => {
    const { panel, sent } = setup();
    panel.connected(true);
    panel.handleFrame({ type: 'app:agent-tokens', requestId: 'r1', tokens: [summary] });

    byId('agent-token-list').querySelector<HTMLButtonElement>('button')!.click();

    expect(sent.at(-1)).toEqual({ type: 'app:agent-token:revoke', id: 'tok-1' });
  });

  it("shows the desktop's refusal of its own request, and leaves other errors alone", () => {
    const { panel } = setup();
    panel.connected(true);

    expect(
      panel.handleFrame({ type: 'app:error', requestId: 'other', code: 'x', message: 'Nope' })
    ).toBe(false);
    expect(
      panel.handleFrame({
        type: 'app:error',
        requestId: 'r1',
        code: 'agent-token-rejected',
        message: 'Komla keeps at most 32 agent tokens. Revoke one first.',
      })
    ).toBe(true);
    expect(byId('agent-token-hint').textContent).toBe(
      'Komla keeps at most 32 agent tokens. Revoke one first.'
    );
  });

  it('says when a token expires and when it was last used', () => {
    expect(agentTokenDetail({ ...summary, expiresAt: NOW + 1 }, NOW)).toBe(
      'SSH hosts only · Expires in 1 day · never used'
    );
    expect(agentTokenDetail({ ...summary, expiresAt: NOW }, NOW)).toBe('SSH hosts only · Expired');
    expect(agentTokenDetail({ ...summary, sshOnly: false, lastUsedAt: NOW }, NOW)).toMatch(
      /^SSH hosts and this computer · Expires in 30 days · used /
    );
  });
});

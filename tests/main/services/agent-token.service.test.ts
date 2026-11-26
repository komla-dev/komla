import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockElectron } from '../../mocks/electron';

import { AgentTokenService } from '../../../src/main/services/agent-token.service';
import { MAX_AGENT_TOKENS } from '../../../src/shared/types/agent-token';

vi.mock('electron', () => mockElectron());
vi.mock('../../../src/main/services/paired-device-registry.service', () => ({
  pairedDeviceRegistryService: { list: vi.fn(() => []), onChange: vi.fn(() => () => {}) },
}));

const DAY_MS = 24 * 60 * 60_000;

describe('AgentTokenService', () => {
  let dir: string;
  let path: string;
  let now: number;
  let devices: Array<{ credentialId: string }>;
  let deviceListeners: Array<() => void>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'komla-agent-tokens-'));
    path = join(dir, 'remote-agent-tokens.json');
    now = 1_000_000;
    devices = [{ credentialId: 'passkey-1' }, { credentialId: 'passkey-2' }];
    deviceListeners = [];
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function service() {
    return new AgentTokenService({
      path,
      now: () => now,
      devices: {
        list: () => devices,
        onChange: (listener) => {
          deviceListeners.push(listener);
          return () => {};
        },
      },
    });
  }

  function create(
    tokens: AgentTokenService,
    overrides: Partial<{ credentialId: string; sshOnly: boolean; lifetimeDays: null }> = {}
  ) {
    return tokens.create({
      label: 'Grok bot',
      projectIds: ['web'],
      lifetimeDays: 30,
      credentialId: 'passkey-1',
      ...overrides,
    });
  }

  it('keeps a token that never expires until it is revoked', () => {
    const tokens = service();
    const { token, summary } = create(tokens, { lifetimeDays: null });
    expect(summary.expiresAt).toBeNull();

    now += 10 * 365 * DAY_MS;
    expect(service().authenticate(token)).toMatchObject({ id: summary.id });
    service().revoke(summary.id);
    expect(service().authenticate(token)).toBeNull();
  });

  it('keeps a token off this computer unless the request lets it in', () => {
    const tokens = service();

    expect(create(tokens).summary.sshOnly).toBe(true);
    const anywhere = create(tokens, { sshOnly: false });
    expect(anywhere.summary.sshOnly).toBe(false);
    expect(service().authenticate(anywhere.token)?.sshOnly).toBe(false);
  });

  it('authenticates the token it made, and keeps only its hash on disk', () => {
    const tokens = service();
    const { token, summary } = create(tokens);

    expect(token).toMatch(/^komla_agent_[A-Za-z0-9_-]{43}$/);
    expect(summary).toEqual({
      id: expect.any(String),
      label: 'Grok bot',
      projectIds: ['web'],
      sshOnly: true,
      createdAt: now,
      expiresAt: now + 30 * DAY_MS,
    });
    const file = readFileSync(path, 'utf8');
    expect(file).not.toContain(token);
    expect(file).not.toContain(token.slice('komla_agent_'.length));
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);

    // A fresh service reads the token back from disk.
    expect(service().authenticate(token)).toMatchObject({ id: summary.id, projectIds: ['web'] });
  });

  it('refuses tokens it never made, malformed ones and expired ones', () => {
    const tokens = service();
    const { token } = create(tokens);

    expect(tokens.authenticate(`${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`)).toBe(
      null
    );
    expect(tokens.authenticate('')).toBe(null);
    expect(tokens.authenticate(`Bearer ${token}`)).toBe(null);

    now += 30 * DAY_MS;
    expect(tokens.authenticate(token)).toBe(null);
    expect(tokens.list()).toEqual([]);
  });

  it('records when a token was last used, at most once a minute', () => {
    const tokens = service();
    const { token } = create(tokens);

    now += 5_000;
    tokens.authenticate(token);
    expect(tokens.list()[0].lastUsedAt).toBe(now);

    const first = now;
    now += 30_000;
    tokens.authenticate(token);
    expect(tokens.list()[0].lastUsedAt).toBe(first);
  });

  it('ends a token when it is revoked, or when everything is', () => {
    const tokens = service();
    const one = create(tokens);
    const two = create(tokens);

    expect(tokens.revoke(one.summary.id)).toBe(true);
    expect(tokens.revoke(one.summary.id)).toBe(false);
    expect(tokens.authenticate(one.token)).toBe(null);
    expect(tokens.authenticate(two.token)).not.toBe(null);

    tokens.revokeAll();
    expect(tokens.authenticate(two.token)).toBe(null);
    expect(service().list()).toEqual([]);
  });

  it('ends the tokens a passkey approved once the passkey is removed', () => {
    const tokens = service();
    tokens.start();
    const removed = create(tokens, { credentialId: 'passkey-1' });
    const kept = create(tokens, { credentialId: 'passkey-2' });

    devices = [{ credentialId: 'passkey-2' }];
    for (const listener of deviceListeners) listener();

    expect(tokens.authenticate(removed.token)).toBe(null);
    expect(tokens.authenticate(kept.token)).not.toBe(null);
  });

  it('validates what the approval asks for', () => {
    const tokens = service();
    const request = {
      label: 'Bot',
      projectIds: ['web'],
      lifetimeDays: 30 as const,
      credentialId: 'passkey-1',
    };

    expect(() => tokens.create({ ...request, label: '   ' })).toThrow(/Name the agent/);
    expect(() => tokens.create({ ...request, label: 'x'.repeat(65) })).toThrow(/Name the agent/);
    expect(() => tokens.create({ ...request, projectIds: [] })).toThrow(/at least one project/);
    expect(() => tokens.create({ ...request, lifetimeDays: 365 as never })).toThrow(/how long/);
    expect(() => tokens.create({ ...request, credentialId: 'gone' })).toThrow(/no longer trusted/);
    expect(tokens.create({ ...request, label: '  My\n bot ' }).summary.label).toBe('My bot');
  });

  it(`keeps at most ${MAX_AGENT_TOKENS} tokens`, () => {
    const tokens = service();
    for (let i = 0; i < MAX_AGENT_TOKENS; i++) create(tokens);

    expect(() => create(tokens)).toThrow(/at most/);
  });

  it('tells listeners what changed, without the tokens', () => {
    const tokens = service();
    const seen: unknown[] = [];
    tokens.onChange((list) => seen.push(list));

    const { token, summary } = create(tokens);

    expect(seen).toEqual([[summary]]);
    expect(JSON.stringify(seen)).not.toContain(token);
  });
});

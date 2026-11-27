import { describe, expect, it, vi } from 'vitest';

import { mockElectron } from '../../mocks/electron';

vi.mock('electron', () => mockElectron());
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('../../../src/main/services/workspace.service', () => ({ workspaceService: {} }));
vi.mock('../../../src/main/services/pty.service', () => ({ ptyService: {} }));
vi.mock('../../../src/main/services/project.service', () => ({ projectService: {} }));
vi.mock('../../../src/main/services/agent-preset.service', () => ({ agentPresetService: {} }));
vi.mock('../../../src/main/services/config.service', () => ({
  configService: { get: vi.fn(() => ({})) },
}));
vi.mock('../../../src/main/services/ssh-host.service', () => ({
  sshHostService: { list: vi.fn(() => []) },
}));
vi.mock('../../../src/main/services/action.service', () => ({ actionService: {} }));
vi.mock('../../../src/main/services/git.service', () => ({ gitService: {} }));
vi.mock('../../../src/main/services/voice-transcription.service', () => ({
  voiceTranscriptionService: { getStatus: vi.fn(() => 'not-downloaded') },
}));
vi.mock('../../../src/main/services/window.service', () => ({
  windowService: { getMainWindowId: vi.fn(() => null), broadcastWhenReady: vi.fn() },
}));
vi.mock('../../../src/main/services/paired-device-registry.service', () => ({
  pairedDeviceRegistryService: { list: vi.fn(() => []), onChange: vi.fn(() => () => {}) },
}));

import { RemoteControlSessionService } from '../../../src/main/services/remote-control-session.service';
import { REMOTE_CAPABILITIES } from '@komla/remote-protocol';

import type { DecodedMessage } from '@komla/remote-protocol';

class FakePeer {
  sent: unknown[] = [];
  private handlers: Array<(msg: DecodedMessage) => void> = [];

  onMessage(cb: (msg: DecodedMessage) => void): void {
    this.handlers.push(cb);
  }

  onClose(): void {}

  async sendEncryptedJson(value: unknown): Promise<void> {
    this.sent.push(value);
  }

  async emit(data: unknown): Promise<void> {
    for (const handler of this.handlers) handler({ kind: 'json', data });
    // Frames are handled on a promise chain; let it drain.
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }
}

const TOKEN = `komla_agent_${'A'.repeat(43)}`;
const summary = {
  id: 'tok-1',
  label: 'Grok bot',
  projectIds: ['web'],
  sshOnly: true,
  createdAt: 1,
  expiresAt: 2,
};

function makeSession(capabilities: string[] = [REMOTE_CAPABILITIES.AGENT_TOKENS]) {
  const agentTokens = {
    list: vi.fn(() => [summary]),
    create: vi.fn(() => ({ token: TOKEN, summary })),
    revoke: vi.fn(() => true),
  };
  const noop = () => () => {};
  const service = new RemoteControlSessionService({
    pty: { onData: noop, onReset: noop, onStatus: noop, onExit: noop } as never,
    push: { registerViewer: vi.fn(() => () => {}) } as never,
    projects: {
      list: () => [{ id: 'web', name: 'Web' }] as never,
      get: () => undefined,
    },
    agentTokens,
  });
  const peer = new FakePeer();
  service.attachPeer(peer, { credentialId: 'cred-phone', capabilities });
  return { peer, agentTokens };
}

describe('remote control session agent token frames', () => {
  it('makes a token approved by the passkey the session signed in with, and sends it once', async () => {
    const { peer, agentTokens } = makeSession();

    await peer.emit({
      type: 'app:agent-token:create',
      requestId: 'r1',
      label: 'Grok bot',
      projectIds: ['web'],
      lifetimeDays: 30,
      sshOnly: false,
    });

    expect(agentTokens.create).toHaveBeenCalledWith({
      label: 'Grok bot',
      projectIds: ['web'],
      lifetimeDays: 30,
      sshOnly: false,
      approvedBy: { kind: 'passkey', credentialId: 'cred-phone' },
    });
    expect(peer.sent).toEqual([
      { type: 'app:agent-token:created', requestId: 'r1', token: TOKEN, summary },
    ]);
  });

  it('tells the page why the desktop refused the token', async () => {
    const { peer, agentTokens } = makeSession();
    agentTokens.create.mockImplementation(() => {
      throw new Error('One of those projects no longer exists.');
    });

    await peer.emit({
      type: 'app:agent-token:create',
      requestId: 'r1',
      label: 'Grok bot',
      projectIds: ['web', 'gone'],
      lifetimeDays: 30,
    });

    expect(peer.sent).toEqual([
      {
        type: 'app:error',
        requestId: 'r1',
        code: 'agent-token-rejected',
        message: 'One of those projects no longer exists.',
      },
    ]);
  });

  it('lists tokens, and lists them again after revoking one', async () => {
    const { peer, agentTokens } = makeSession();

    await peer.emit({ type: 'app:agent-tokens:list', requestId: 'r1' });
    await peer.emit({ type: 'app:agent-token:revoke', requestId: 'r2', id: 'tok-1' });

    expect(agentTokens.revoke).toHaveBeenCalledWith('tok-1');
    expect(peer.sent).toEqual([
      { type: 'app:agent-tokens', requestId: 'r1', tokens: [summary] },
      { type: 'app:agent-tokens', requestId: 'r2', tokens: [summary] },
    ]);
  });

  it('refuses every agent token frame from a page that did not agree on them', async () => {
    const { peer, agentTokens } = makeSession([]);

    await peer.emit({ type: 'app:agent-tokens:list', requestId: 'r1' });
    await peer.emit({
      type: 'app:agent-token:create',
      requestId: 'r2',
      label: 'x',
      projectIds: ['web'],
      lifetimeDays: 7,
    });

    expect(agentTokens.list).not.toHaveBeenCalled();
    expect(agentTokens.create).not.toHaveBeenCalled();
    expect(peer.sent).toMatchObject([
      { type: 'app:error', requestId: 'r1', code: 'agent-tokens-unavailable' },
      { type: 'app:error', requestId: 'r2', code: 'agent-tokens-unavailable' },
    ]);
  });
});

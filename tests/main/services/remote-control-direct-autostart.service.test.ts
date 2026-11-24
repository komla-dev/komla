import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockElectron } from '../../mocks/electron';

vi.mock('electron', () => mockElectron());

const mockConfigService = {
  get: vi.fn(),
  update: vi.fn(),
};

vi.mock('../../../src/main/services/config.service', () => ({
  configService: mockConfigService,
}));

const mockRemoteControlKeepAwakeService = {
  sync: vi.fn(),
};

vi.mock('../../../src/main/services/remote-control-keep-awake.service', () => ({
  remoteControlKeepAwakeService: mockRemoteControlKeepAwakeService,
}));

const server = {
  host: '127.0.0.1',
  port: 52864,
  preferredPort: 52864,
  localOrigin: 'http://localhost:52864',
  httpOrigin: 'https://mac.tailnet.ts.net',
  wsUrl: 'wss://mac.tailnet.ts.net/remote/ws?fp=fingerprint',
  fingerprint: 'fingerprint',
};

const mockRemoteControlDirectService = {
  getInfo: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  setStartProblem: vi.fn(),
};

vi.mock('../../../src/main/services/remote-control-direct.service', () => ({
  remoteControlDirectService: mockRemoteControlDirectService,
}));

const mockRemoteControlTailscaleService = {
  assertFunnelOff: vi.fn(),
  reconcile: vi.fn(),
  stop: vi.fn(),
};

const { MockTailscaleFunnelEnabledError, MockTailscaleHttpsPortTakenError } = vi.hoisted(() => ({
  MockTailscaleFunnelEnabledError: class extends Error {},
  MockTailscaleHttpsPortTakenError: class extends Error {},
}));

vi.mock('../../../src/main/services/remote-control-tailscale.service', () => ({
  remoteControlTailscaleService: mockRemoteControlTailscaleService,
  TailscaleFunnelEnabledError: MockTailscaleFunnelEnabledError,
  TailscaleHttpsPortTakenError: MockTailscaleHttpsPortTakenError,
  formatTailscaleError: (err: Error) => `formatted: ${err.message}`,
}));

const managedConfig = {
  directRemoteEnabled: true,
  directRemotePort: 52864,
  directRemotePublicOrigin: 'https://mac.tailnet.ts.net',
  directRemoteManagedTailscaleOrigin: 'https://mac.tailnet.ts.net',
  directRemoteKeepAwake: false,
};

describe('startPersistedDirectRemoteServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockConfigService.get.mockReturnValue({
      directRemoteEnabled: false,
      directRemotePort: 52864,
      directRemotePublicOrigin: undefined,
      directRemoteKeepAwake: false,
    });
    mockRemoteControlDirectService.getInfo.mockReturnValue(null);
    mockRemoteControlDirectService.start.mockResolvedValue(server);
    mockRemoteControlDirectService.stop.mockResolvedValue(undefined);
    mockRemoteControlTailscaleService.assertFunnelOff.mockResolvedValue(undefined);
    mockRemoteControlTailscaleService.reconcile.mockResolvedValue(undefined);
    mockRemoteControlTailscaleService.stop.mockResolvedValue(undefined);
  });

  it('reconciles the persisted Tailscale listener with the bound local port', async () => {
    mockConfigService.get.mockReturnValue({
      directRemoteEnabled: true,
      directRemotePort: 54809,
      directRemotePublicOrigin: 'https://mac.tailnet.ts.net:54809',
      directRemoteManagedTailscaleOrigin: 'https://mac.tailnet.ts.net:54809',
      directRemoteKeepAwake: false,
    });
    mockRemoteControlDirectService.start.mockResolvedValue({
      ...server,
      port: 57948,
      preferredPort: 54809,
      localOrigin: 'http://localhost:57948',
      httpOrigin: 'https://mac.tailnet.ts.net:54809',
    });
    const { startPersistedDirectRemoteServer } = await import(
      '../../../src/main/services/remote-control-direct-autostart.service'
    );

    await startPersistedDirectRemoteServer('boot');

    expect(mockRemoteControlTailscaleService.reconcile).toHaveBeenCalledWith(
      'https://mac.tailnet.ts.net:54809',
      57948,
      expect.objectContaining({ previousLocalPort: 54809 })
    );
  });

  it('does not start the server while Tailscale Funnel exposes the managed port', async () => {
    mockConfigService.get.mockReturnValue(managedConfig);
    mockRemoteControlTailscaleService.assertFunnelOff.mockRejectedValue(
      new MockTailscaleFunnelEnabledError('Funnel is on')
    );
    const { startPersistedDirectRemoteServer } = await import(
      '../../../src/main/services/remote-control-direct-autostart.service'
    );

    await expect(startPersistedDirectRemoteServer('boot')).resolves.toBeNull();

    expect(mockRemoteControlTailscaleService.assertFunnelOff).toHaveBeenCalledWith(
      'https://mac.tailnet.ts.net'
    );
    expect(mockRemoteControlDirectService.start).not.toHaveBeenCalled();
  });

  it('stops the server when Tailscale Funnel is found on the managed port', async () => {
    mockConfigService.get.mockReturnValue(managedConfig);
    mockRemoteControlTailscaleService.reconcile.mockRejectedValue(
      new MockTailscaleFunnelEnabledError('Funnel is on')
    );
    const { startPersistedDirectRemoteServer } = await import(
      '../../../src/main/services/remote-control-direct-autostart.service'
    );

    await expect(startPersistedDirectRemoteServer('boot')).resolves.toBeNull();

    expect(mockRemoteControlDirectService.stop).toHaveBeenCalledOnce();
  });

  it('retries the Tailscale listener while Tailscale is still starting', async () => {
    vi.useFakeTimers();
    mockConfigService.get.mockReturnValue(managedConfig);
    mockRemoteControlTailscaleService.reconcile.mockRejectedValueOnce(
      new Error('failed to connect to local tailscaled')
    );
    const { startPersistedDirectRemoteServer } = await import(
      '../../../src/main/services/remote-control-direct-autostart.service'
    );

    await expect(startPersistedDirectRemoteServer('boot')).resolves.toEqual(server);
    mockRemoteControlDirectService.getInfo.mockReturnValue(server);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(mockRemoteControlTailscaleService.reconcile).toHaveBeenCalledTimes(2);
    expect(mockRemoteControlTailscaleService.reconcile).toHaveBeenLastCalledWith(
      'https://mac.tailnet.ts.net',
      52864,
      expect.anything()
    );
  });

  it('starts the server from persisted settings when remote control is enabled', async () => {
    mockConfigService.get.mockReturnValue({
      directRemoteEnabled: true,
      directRemotePort: 52864,
      directRemotePublicOrigin: 'https://mac.tailnet.ts.net',
      directRemoteKeepAwake: true,
    });
    const { startPersistedDirectRemoteServer } = await import(
      '../../../src/main/services/remote-control-direct-autostart.service'
    );

    await expect(startPersistedDirectRemoteServer('boot')).resolves.toEqual(server);

    expect(mockRemoteControlDirectService.start).toHaveBeenCalledWith({
      port: 52864,
      publicOrigin: 'https://mac.tailnet.ts.net',
    });
    expect(mockRemoteControlKeepAwakeService.sync).toHaveBeenCalledWith(true, true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('keeps remote control up without opening Settings', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      // The fake server: getInfo reports whatever start or stop last left.
      let running: typeof server | null = null;
      mockRemoteControlDirectService.getInfo.mockImplementation(() => running);
      mockRemoteControlDirectService.start.mockImplementation(async () => (running = server));
      mockRemoteControlDirectService.stop.mockImplementation(async () => {
        running = null;
      });
    });

    it('retries starting the server when the first start at launch fails', async () => {
      mockConfigService.get.mockReturnValue(managedConfig);
      mockRemoteControlDirectService.start.mockRejectedValueOnce(
        new Error('Failed to decrypt install identity')
      );
      const { startPersistedDirectRemoteServer } = await import(
        '../../../src/main/services/remote-control-direct-autostart.service'
      );

      await expect(startPersistedDirectRemoteServer('boot')).resolves.toBeNull();
      expect(mockRemoteControlDirectService.setStartProblem).toHaveBeenLastCalledWith(
        expect.stringContaining('Failed to decrypt install identity')
      );
      await vi.advanceTimersByTimeAsync(5_000);

      expect(mockRemoteControlDirectService.start).toHaveBeenCalledTimes(2);
      expect(mockRemoteControlDirectService.getInfo()).toEqual(server);
      expect(mockRemoteControlTailscaleService.reconcile).toHaveBeenCalledWith(
        'https://mac.tailnet.ts.net',
        52864,
        expect.anything()
      );
    });

    it('keeps retrying a failed start for as long as it keeps failing', async () => {
      mockConfigService.get.mockReturnValue(managedConfig);
      mockRemoteControlDirectService.start.mockRejectedValue(new Error('keychain locked'));
      const { startPersistedDirectRemoteServer } = await import(
        '../../../src/main/services/remote-control-direct-autostart.service'
      );

      await startPersistedDirectRemoteServer('boot');
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      const attemptsInFirstHour = mockRemoteControlDirectService.start.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60 * 60_000);

      expect(attemptsInFirstHour).toBeGreaterThan(5);
      expect(mockRemoteControlDirectService.start.mock.calls.length).toBeGreaterThan(
        attemptsInFirstHour
      );
    });

    it('retries a failed start right away when the computer wakes or unlocks', async () => {
      mockConfigService.get.mockReturnValue(managedConfig);
      mockRemoteControlDirectService.start.mockRejectedValueOnce(new Error('keychain locked'));
      const { startPersistedDirectRemoteServer } = await import(
        '../../../src/main/services/remote-control-direct-autostart.service'
      );

      await startPersistedDirectRemoteServer('boot');
      await expect(startPersistedDirectRemoteServer('resume')).resolves.toEqual(server);

      expect(mockRemoteControlDirectService.start).toHaveBeenCalledTimes(2);
    });

    it('stops retrying once remote control is turned off', async () => {
      mockConfigService.get.mockReturnValue(managedConfig);
      mockRemoteControlDirectService.start.mockRejectedValue(new Error('keychain locked'));
      const { startPersistedDirectRemoteServer } = await import(
        '../../../src/main/services/remote-control-direct-autostart.service'
      );

      await startPersistedDirectRemoteServer('boot');
      mockConfigService.get.mockReturnValue({ ...managedConfig, directRemoteEnabled: false });
      await vi.advanceTimersByTimeAsync(60 * 60_000);

      expect(mockRemoteControlDirectService.start).toHaveBeenCalledOnce();
    });

    it('keeps retrying the Tailscale route until Tailscale comes up, however long it takes', async () => {
      mockConfigService.get.mockReturnValue(managedConfig);
      let tailscaleUp = false;
      mockRemoteControlTailscaleService.reconcile.mockImplementation(async () => {
        if (!tailscaleUp) throw new Error('failed to connect to local tailscaled');
      });
      const { startPersistedDirectRemoteServer } = await import(
        '../../../src/main/services/remote-control-direct-autostart.service'
      );

      await startPersistedDirectRemoteServer('boot');
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      tailscaleUp = true;
      const failedAttempts = mockRemoteControlTailscaleService.reconcile.mock.calls.length;
      await vi.advanceTimersByTimeAsync(10 * 60_000);

      expect(mockRemoteControlTailscaleService.reconcile.mock.calls.length).toBeGreaterThan(
        failedAttempts
      );
      expect(mockRemoteControlDirectService.setStartProblem).toHaveBeenLastCalledWith(null);
    });

    it('puts the Tailscale route back when something removes it later', async () => {
      mockConfigService.get.mockReturnValue(managedConfig);
      const { startPersistedDirectRemoteServer } = await import(
        '../../../src/main/services/remote-control-direct-autostart.service'
      );

      await startPersistedDirectRemoteServer('boot');
      expect(mockRemoteControlTailscaleService.reconcile).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(10 * 60_000);

      expect(mockRemoteControlTailscaleService.reconcile.mock.calls.length).toBeGreaterThan(1);
    });

    it('leaves a working route alone when Settings reads the state', async () => {
      mockConfigService.get.mockReturnValue(managedConfig);
      const { startPersistedDirectRemoteServer } = await import(
        '../../../src/main/services/remote-control-direct-autostart.service'
      );

      await startPersistedDirectRemoteServer('boot');
      await expect(startPersistedDirectRemoteServer('state-read')).resolves.toEqual(server);
      await vi.advanceTimersByTimeAsync(0);

      // Tailscale work would hold the route lock that turning remote control off waits on.
      expect(mockRemoteControlTailscaleService.reconcile).toHaveBeenCalledOnce();
    });

    it('checks the route at once when the computer wakes', async () => {
      mockConfigService.get.mockReturnValue(managedConfig);
      const { startPersistedDirectRemoteServer } = await import(
        '../../../src/main/services/remote-control-direct-autostart.service'
      );

      await startPersistedDirectRemoteServer('boot');
      await startPersistedDirectRemoteServer('resume');
      await vi.advanceTimersByTimeAsync(0);

      expect(mockRemoteControlTailscaleService.reconcile).toHaveBeenCalledTimes(2);
    });

    it('stops checking the route once remote control is turned off', async () => {
      mockConfigService.get.mockReturnValue(managedConfig);
      const { forgetPersistedDirectRemoteServer, startPersistedDirectRemoteServer } =
        await import('../../../src/main/services/remote-control-direct-autostart.service');

      await startPersistedDirectRemoteServer('boot');
      forgetPersistedDirectRemoteServer();
      await vi.advanceTimersByTimeAsync(60 * 60_000);

      expect(mockRemoteControlTailscaleService.reconcile).toHaveBeenCalledOnce();
      expect(mockRemoteControlDirectService.setStartProblem).toHaveBeenLastCalledWith(null);
    });

    it('does not put the route back after the app starts shutting down', async () => {
      mockConfigService.get.mockReturnValue(managedConfig);
      const { startPersistedDirectRemoteServer, stopPersistedDirectRemoteServer } = await import(
        '../../../src/main/services/remote-control-direct-autostart.service'
      );

      await startPersistedDirectRemoteServer('boot');
      await stopPersistedDirectRemoteServer();
      await expect(startPersistedDirectRemoteServer('resume')).resolves.toBeNull();
      await vi.advanceTimersByTimeAsync(60 * 60_000);

      expect(mockRemoteControlTailscaleService.reconcile).toHaveBeenCalledOnce();
      expect(mockRemoteControlDirectService.start).toHaveBeenCalledOnce();
    });

    it("stops taking the HTTPS port back once another program's route holds it", async () => {
      mockConfigService.get.mockReturnValue(managedConfig);
      const { startPersistedDirectRemoteServer } = await import(
        '../../../src/main/services/remote-control-direct-autostart.service'
      );
      await startPersistedDirectRemoteServer('boot');
      mockRemoteControlTailscaleService.reconcile.mockRejectedValue(
        new MockTailscaleHttpsPortTakenError('Another Tailscale Serve route uses HTTPS port 443.')
      );

      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(mockRemoteControlTailscaleService.reconcile).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(4 * 60_000);

      // Checked again at the normal interval, not retried with backoff.
      expect(mockRemoteControlTailscaleService.reconcile).toHaveBeenCalledTimes(2);
      expect(mockRemoteControlDirectService.stop).not.toHaveBeenCalled();
      expect(mockRemoteControlDirectService.setStartProblem).toHaveBeenLastCalledWith(
        expect.stringContaining('HTTPS port 443')
      );
    });

    it('clears the start problem once the server runs, whoever started it', async () => {
      mockConfigService.get.mockReturnValue({
        ...managedConfig,
        directRemoteManagedTailscaleOrigin: undefined,
      });
      mockRemoteControlDirectService.start.mockRejectedValueOnce(new Error('keychain locked'));
      const { startPersistedDirectRemoteServer } = await import(
        '../../../src/main/services/remote-control-direct-autostart.service'
      );
      await startPersistedDirectRemoteServer('boot');
      // Pairing from Settings started it.
      await mockRemoteControlDirectService.start();

      await startPersistedDirectRemoteServer('retry');
      await vi.advanceTimersByTimeAsync(0);

      expect(mockRemoteControlDirectService.setStartProblem).toHaveBeenLastCalledWith(null);
    });

    it('clears the start problem when remote control is turned off in the config', async () => {
      mockConfigService.get.mockReturnValue(managedConfig);
      mockRemoteControlDirectService.start.mockRejectedValueOnce(new Error('keychain locked'));
      const { startPersistedDirectRemoteServer } = await import(
        '../../../src/main/services/remote-control-direct-autostart.service'
      );
      await startPersistedDirectRemoteServer('boot');
      mockConfigService.get.mockReturnValue({ ...managedConfig, directRemoteEnabled: false });

      await startPersistedDirectRemoteServer('state-read');
      await vi.advanceTimersByTimeAsync(0);

      expect(mockRemoteControlDirectService.setStartProblem).toHaveBeenLastCalledWith(null);
    });

    it('removes the route Komla manages when it quits, even one published while it waited', async () => {
      const config = { ...managedConfig };
      mockConfigService.get.mockImplementation(() => config);
      const {
        startPersistedDirectRemoteServer,
        stopPersistedDirectRemoteServer,
        withTailscaleRouteLock,
      } = await import('../../../src/main/services/remote-control-direct-autostart.service');
      await startPersistedDirectRemoteServer('boot');
      let finishPublish!: () => void;
      const publish = withTailscaleRouteLock(
        () =>
          new Promise<void>((resolve) => {
            finishPublish = () => {
              config.directRemoteManagedTailscaleOrigin = 'https://mac.tailnet.ts.net:8443';
              resolve();
            };
          })
      );

      const quitting = stopPersistedDirectRemoteServer();
      await vi.advanceTimersByTimeAsync(0);
      finishPublish();
      await publish;
      await quitting;

      expect(mockRemoteControlTailscaleService.stop).toHaveBeenCalledWith(
        'https://mac.tailnet.ts.net:8443',
        5_000
      );
    });

    it('tells a route check under way not to publish once Komla is quitting', async () => {
      mockConfigService.get.mockReturnValue(managedConfig);
      const { startPersistedDirectRemoteServer, stopPersistedDirectRemoteServer } = await import(
        '../../../src/main/services/remote-control-direct-autostart.service'
      );
      await startPersistedDirectRemoteServer('boot');
      const [, , options] = mockRemoteControlTailscaleService.reconcile.mock.calls[0]!;
      expect(options.shouldApply()).toBe(true);

      await stopPersistedDirectRemoteServer();

      expect(options.shouldApply()).toBe(false);
    });

    it("replaces Komla's own stale route on later tries, after it moved to another port", async () => {
      const config = { ...managedConfig };
      mockConfigService.get.mockImplementation(() => config);
      mockConfigService.update.mockImplementation((updates: Partial<typeof config>) =>
        Object.assign(config, updates)
      );
      const moved = { ...server, port: 52865, localOrigin: 'http://localhost:52865' };
      mockRemoteControlDirectService.start.mockImplementation(async () => {
        mockRemoteControlDirectService.getInfo.mockReturnValue(moved);
        return moved;
      });
      mockRemoteControlTailscaleService.reconcile.mockRejectedValueOnce(
        new Error('failed to connect to local tailscaled')
      );
      const { startPersistedDirectRemoteServer } = await import(
        '../../../src/main/services/remote-control-direct-autostart.service'
      );

      await startPersistedDirectRemoteServer('boot');
      await vi.advanceTimersByTimeAsync(5_000);

      expect(mockRemoteControlTailscaleService.reconcile).toHaveBeenLastCalledWith(
        'https://mac.tailnet.ts.net',
        52865,
        expect.objectContaining({ previousLocalPort: 52864 })
      );
    });

    it('starts checking the route once it is published from Settings', async () => {
      const config: typeof managedConfig = {
        ...managedConfig,
        directRemoteManagedTailscaleOrigin: undefined as unknown as string,
      };
      mockConfigService.get.mockImplementation(() => config);
      const { startPersistedDirectRemoteServer, watchPersistedTailscaleRoute } = await import(
        '../../../src/main/services/remote-control-direct-autostart.service'
      );
      await startPersistedDirectRemoteServer('boot');
      config.directRemoteManagedTailscaleOrigin = 'https://mac.tailnet.ts.net';

      watchPersistedTailscaleRoute();
      await vi.advanceTimersByTimeAsync(5 * 60_000);

      expect(mockRemoteControlTailscaleService.reconcile).toHaveBeenCalledOnce();
    });

    it('checks the route when Settings opens without undoing the backoff', async () => {
      mockConfigService.get.mockReturnValue(managedConfig);
      mockRemoteControlTailscaleService.reconcile.mockRejectedValue(new Error('tailscaled down'));
      const { startPersistedDirectRemoteServer } = await import(
        '../../../src/main/services/remote-control-direct-autostart.service'
      );
      await startPersistedDirectRemoteServer('boot');
      // Tries at 5s, 15s, 30s, 1m and 2m back off to 5 minutes.
      await vi.advanceTimersByTimeAsync((5 + 15 + 30 + 60 + 120) * 1_000);
      const tries = mockRemoteControlTailscaleService.reconcile.mock.calls.length;

      await startPersistedDirectRemoteServer('state-read');
      await vi.advanceTimersByTimeAsync(0);
      expect(mockRemoteControlTailscaleService.reconcile).toHaveBeenCalledTimes(tries + 1);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(mockRemoteControlTailscaleService.reconcile).toHaveBeenCalledTimes(tries + 1);
    });

    it('does not retry a start that fails while Komla quits', async () => {
      mockConfigService.get.mockReturnValue(managedConfig);
      let failStart!: () => void;
      mockRemoteControlDirectService.start.mockImplementationOnce(
        () => new Promise((_, reject) => (failStart = () => reject(new Error('keychain locked'))))
      );
      const { startPersistedDirectRemoteServer, stopPersistedDirectRemoteServer } = await import(
        '../../../src/main/services/remote-control-direct-autostart.service'
      );
      const starting = startPersistedDirectRemoteServer('boot');
      await vi.advanceTimersByTimeAsync(0);

      const quitting = stopPersistedDirectRemoteServer();
      failStart();
      await starting;
      await quitting;

      expect(vi.getTimerCount()).toBe(0);
    });

    it('starts once Tailscale Funnel is turned off after it kept remote control from starting', async () => {
      mockConfigService.get.mockReturnValue(managedConfig);
      mockRemoteControlTailscaleService.assertFunnelOff.mockRejectedValueOnce(
        new MockTailscaleFunnelEnabledError('Funnel is on')
      );
      const { startPersistedDirectRemoteServer } = await import(
        '../../../src/main/services/remote-control-direct-autostart.service'
      );

      await expect(startPersistedDirectRemoteServer('boot')).resolves.toBeNull();
      expect(mockRemoteControlDirectService.start).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5_000);

      expect(mockRemoteControlDirectService.start).toHaveBeenCalledOnce();
      expect(mockRemoteControlDirectService.getInfo()).toEqual(server);
    });

    it('starts again once Tailscale Funnel is turned off after a route check stopped it', async () => {
      mockConfigService.get.mockReturnValue(managedConfig);
      const { startPersistedDirectRemoteServer } = await import(
        '../../../src/main/services/remote-control-direct-autostart.service'
      );
      await startPersistedDirectRemoteServer('boot');
      mockRemoteControlTailscaleService.reconcile.mockRejectedValueOnce(
        new MockTailscaleFunnelEnabledError('Funnel is on')
      );

      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(mockRemoteControlDirectService.getInfo()).toBeNull();
      await vi.advanceTimersByTimeAsync(5_000);

      expect(mockRemoteControlDirectService.start).toHaveBeenCalledTimes(2);
      expect(mockRemoteControlDirectService.getInfo()).toEqual(server);
    });

    it('leaves a pending start retry and its backoff alone when Settings reads the state', async () => {
      mockConfigService.get.mockReturnValue(managedConfig);
      mockRemoteControlDirectService.start.mockRejectedValue(new Error('keychain locked'));
      const { startPersistedDirectRemoteServer } = await import(
        '../../../src/main/services/remote-control-direct-autostart.service'
      );
      await startPersistedDirectRemoteServer('boot');
      await vi.advanceTimersByTimeAsync(5_000);
      expect(mockRemoteControlDirectService.start).toHaveBeenCalledTimes(2);

      await startPersistedDirectRemoteServer('state-read');
      expect(mockRemoteControlDirectService.start).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(14_000);
      expect(mockRemoteControlDirectService.start).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(mockRemoteControlDirectService.start).toHaveBeenCalledTimes(3);
    });

    it('forgets the old server port when remote control is turned off', async () => {
      const config = { ...managedConfig };
      mockConfigService.get.mockImplementation(() => config);
      mockConfigService.update.mockImplementation((updates: Partial<typeof config>) =>
        Object.assign(config, updates)
      );
      const moved = { ...server, port: 52865, localOrigin: 'http://localhost:52865' };
      mockRemoteControlDirectService.start.mockImplementation(async () => {
        mockRemoteControlDirectService.getInfo.mockReturnValue(moved);
        return moved;
      });
      mockRemoteControlTailscaleService.reconcile.mockRejectedValueOnce(
        new Error('tailscaled down')
      );
      const {
        forgetPersistedDirectRemoteServer,
        startPersistedDirectRemoteServer,
        watchPersistedTailscaleRoute,
      } = await import('../../../src/main/services/remote-control-direct-autostart.service');
      await startPersistedDirectRemoteServer('boot');

      forgetPersistedDirectRemoteServer();
      watchPersistedTailscaleRoute();
      await vi.advanceTimersByTimeAsync(5 * 60_000);

      expect(mockRemoteControlTailscaleService.reconcile).toHaveBeenLastCalledWith(
        'https://mac.tailnet.ts.net',
        52865,
        expect.objectContaining({ previousLocalPort: 52865 })
      );
    });

    it('says what Tailscale reported when the route could not be published', async () => {
      mockConfigService.get.mockReturnValue(managedConfig);
      mockRemoteControlTailscaleService.reconcile.mockRejectedValueOnce(
        new Error('Command failed: tailscale serve status --json')
      );
      const { startPersistedDirectRemoteServer } = await import(
        '../../../src/main/services/remote-control-direct-autostart.service'
      );

      await startPersistedDirectRemoteServer('boot');

      expect(mockRemoteControlDirectService.setStartProblem).toHaveBeenLastCalledWith(
        expect.stringContaining('formatted: Command failed')
      );
    });

    it('runs a route check after a route change that was already under way', async () => {
      mockConfigService.get.mockReturnValue(managedConfig);
      const { startPersistedDirectRemoteServer, withTailscaleRouteLock } = await import(
        '../../../src/main/services/remote-control-direct-autostart.service'
      );
      await startPersistedDirectRemoteServer('boot');
      let finishChange!: () => void;
      const change = withTailscaleRouteLock(
        () => new Promise<void>((resolve) => (finishChange = resolve))
      );

      await startPersistedDirectRemoteServer('resume');
      await vi.advanceTimersByTimeAsync(0);
      expect(mockRemoteControlTailscaleService.reconcile).toHaveBeenCalledOnce();
      finishChange();
      await change;
      await vi.advanceTimersByTimeAsync(0);

      expect(mockRemoteControlTailscaleService.reconcile).toHaveBeenCalledTimes(2);
    });
  });

  it('does not start the server when remote control is disabled', async () => {
    const { startPersistedDirectRemoteServer } = await import(
      '../../../src/main/services/remote-control-direct-autostart.service'
    );

    await expect(startPersistedDirectRemoteServer('boot')).resolves.toBeNull();

    expect(mockRemoteControlDirectService.start).not.toHaveBeenCalled();
  });

  it('releases the local server during app shutdown when remote control is enabled', async () => {
    mockConfigService.get.mockReturnValue({ directRemoteEnabled: true });
    const { stopPersistedDirectRemoteServer } = await import(
      '../../../src/main/services/remote-control-direct-autostart.service'
    );

    await stopPersistedDirectRemoteServer();

    expect(mockRemoteControlDirectService.stop).toHaveBeenCalledOnce();
  });

  it('removes the managed Tailscale listener before releasing the local server at shutdown', async () => {
    mockConfigService.get.mockReturnValue(managedConfig);
    const { stopPersistedDirectRemoteServer } = await import(
      '../../../src/main/services/remote-control-direct-autostart.service'
    );

    await stopPersistedDirectRemoteServer();

    // While Komla is closed, any program that takes the port would be on the tailnet.
    expect(mockRemoteControlTailscaleService.stop).toHaveBeenCalledWith(
      'https://mac.tailnet.ts.net',
      5_000
    );
    expect(mockRemoteControlTailscaleService.stop.mock.invocationCallOrder[0]).toBeLessThan(
      mockRemoteControlDirectService.stop.mock.invocationCallOrder[0]!
    );
    expect(mockConfigService.update).not.toHaveBeenCalled();
  });

  it('still releases the local server when removing the Tailscale listener fails', async () => {
    mockConfigService.get.mockReturnValue(managedConfig);
    mockRemoteControlTailscaleService.stop.mockRejectedValue(new Error('tailscaled is down'));
    const { stopPersistedDirectRemoteServer } = await import(
      '../../../src/main/services/remote-control-direct-autostart.service'
    );

    await stopPersistedDirectRemoteServer();

    expect(mockRemoteControlDirectService.stop).toHaveBeenCalledOnce();
  });

  it('retries removing a Tailscale listener that turning remote control off left behind', async () => {
    const leftover = { ...managedConfig, directRemoteEnabled: false };
    mockConfigService.get.mockReturnValue(leftover);
    mockRemoteControlTailscaleService.stop.mockRejectedValueOnce(new Error('tailscaled is down'));
    const { startPersistedDirectRemoteServer, stopPersistedDirectRemoteServer } = await import(
      '../../../src/main/services/remote-control-direct-autostart.service'
    );

    await expect(startPersistedDirectRemoteServer('state-read')).resolves.toBeNull();
    expect(mockRemoteControlTailscaleService.stop).not.toHaveBeenCalled();
    await expect(startPersistedDirectRemoteServer('boot')).resolves.toBeNull();
    expect(mockConfigService.update).not.toHaveBeenCalled();

    await stopPersistedDirectRemoteServer();

    expect(mockRemoteControlTailscaleService.stop).toHaveBeenCalledTimes(2);
    expect(mockRemoteControlTailscaleService.stop).toHaveBeenLastCalledWith(
      'https://mac.tailnet.ts.net',
      5_000
    );
    expect(mockConfigService.update).toHaveBeenCalledWith({
      directRemoteManagedTailscaleOrigin: undefined,
    });
    expect(mockRemoteControlDirectService.start).not.toHaveBeenCalled();
    expect(mockRemoteControlDirectService.stop).not.toHaveBeenCalled();
  });
});

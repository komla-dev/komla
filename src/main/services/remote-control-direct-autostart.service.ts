import { createLogger } from '../lib/logger';

import { configService } from './config.service';
import { remoteControlKeepAwakeService } from './remote-control-keep-awake.service';
import {
  formatTailscaleError,
  remoteControlTailscaleService,
  TailscaleFunnelEnabledError,
  TailscaleHttpsPortTakenError,
} from './remote-control-tailscale.service';

import type { RemoteControlDirectServerInfo } from '../../shared/types/remote-control';

const logger = createLogger('RemoteControlDirectAutostart');

// The keychain or Tailscale can still be starting when Komla launches at login, and can take much
// longer than that after a restart. Retries back off to the last delay and keep going from there.
const RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];
// Tailscale restarts, sign-outs and other programs can take the route down while Komla runs.
const ROUTE_CHECK_INTERVAL_MS = 5 * 60_000;
const TAILSCALE_SHUTDOWN_TIMEOUT_MS = 5_000;

type StartReason = 'boot' | 'state-read' | 'resume' | 'retry';

let startInFlight: Promise<RemoteControlDirectServerInfo | null> | null = null;
let startRetryTimer: ReturnType<typeof setTimeout> | null = null;
let startAttempt = 0;
let routeCheckTimer: ReturnType<typeof setTimeout> | null = null;
let routeAttempt = 0;
// Where the server listened before it started on another port. A route still pointing there is
// Komla's own, left by a crash, so the route check may replace it until it succeeds once.
let previousServerPort: number | undefined;
let routeChain: Promise<unknown> = Promise.resolve();
let shuttingDown = false;
// Whether this service last put a problem in Settings, so a state read knows to look again.
let problemShown = false;

/**
 * Runs one change to Komla's Tailscale Serve route at a time. A background check that read the
 * config before remote control was turned off would otherwise put the route back after it.
 */
export function withTailscaleRouteLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = routeChain.then(fn, fn);
  routeChain = run.catch(() => undefined);
  return run;
}

export async function startPersistedDirectRemoteServer(
  reason: StartReason = 'boot'
): Promise<RemoteControlDirectServerInfo | null> {
  const config = configService.get();
  if (!config.directRemoteEnabled) {
    forgetPersistedDirectRemoteServer();
    // Only at launch: Settings reads state often, and a stuck tailscale would hold each read.
    if (reason === 'boot') await removeLeftoverTailscaleRoute();
    return null;
  }
  if (shuttingDown) return null;

  const { remoteControlDirectService } = await import('./remote-control-direct.service');
  const existing = remoteControlDirectService.getInfo();
  if (existing && !startInFlight) {
    remoteControlKeepAwakeService.sync(true, config.directRemoteKeepAwake);
    // The computer woke up, or Settings shows a problem the server may have outlived: look now
    // rather than in minutes. A route that works is left alone, since Settings reads state often
    // and turning remote control off waits for a check.
    if (reason === 'resume') checkRouteSoon(0, true);
    else if (problemShown) checkRouteSoon(0);
    return existing;
  }

  if (startInFlight) return startInFlight;
  // A retry is already due: Settings reading state doesn't bring it forward.
  if (reason === 'state-read' && startRetryTimer) return null;
  if (reason === 'boot' || reason === 'resume') startAttempt = 0;
  startInFlight = withTailscaleRouteLock(() => startServer(reason))
    .catch((err: unknown) => {
      logger.warn('failed to start persisted direct remote-control server', {
        reason,
        error: String(err),
      });
      return null;
    })
    .finally(() => {
      startInFlight = null;
    });
  return startInFlight;
}

async function startServer(reason: StartReason): Promise<RemoteControlDirectServerInfo | null> {
  clearStartRetry();
  const config = configService.get();
  if (!config.directRemoteEnabled || shuttingDown) return null;

  const { remoteControlDirectService } = await import('./remote-control-direct.service');
  const existing = remoteControlDirectService.getInfo();
  if (existing) {
    remoteControlKeepAwakeService.sync(true, config.directRemoteKeepAwake);
    return existing;
  }

  const managedOrigin = config.directRemoteManagedTailscaleOrigin;
  if (managedOrigin) {
    try {
      await remoteControlTailscaleService.assertFunnelOff(managedOrigin);
    } catch (err) {
      if (err instanceof TailscaleFunnelEnabledError) {
        logger.error('not starting remote control', { error: err.message });
        showProblem(remoteControlDirectService, err.message);
        // Starting checks Funnel again first, so the retry starts only once it's off.
        scheduleStartRetry(reason);
        return null;
      }
      // Tailscale can't be inspected yet; the route check below retries.
    }
  }

  let server: RemoteControlDirectServerInfo;
  try {
    server = await remoteControlDirectService.start({
      port: config.directRemotePort,
      publicOrigin: config.directRemotePublicOrigin,
    });
  } catch (err) {
    if (shuttingDown) return null;
    logger.warn('failed to start persisted direct remote-control server', {
      reason,
      error: String(err),
    });
    showProblem(
      remoteControlDirectService,
      `Remote control didn't start: ${sentence(errorText(err))} Komla keeps trying.`
    );
    scheduleStartRetry(reason);
    return null;
  }

  startAttempt = 0;
  showProblem(remoteControlDirectService, null);
  if (server.port !== config.directRemotePort) {
    previousServerPort = config.directRemotePort;
    configService.update({ directRemotePort: server.port });
  }
  routeAttempt = 0;
  if (!(await ensureRoute(server.port))) return null;
  logger.info('started persisted direct remote-control server', {
    reason,
    port: server.port,
    preferredPort: server.preferredPort,
  });
  remoteControlKeepAwakeService.sync(true, config.directRemoteKeepAwake);
  return server;
}

/**
 * Points the managed Tailscale route at the running server, then keeps checking it. False when
 * Funnel made it stop the server. Call it holding the route lock.
 */
async function ensureRoute(startedPort?: number): Promise<boolean> {
  clearRouteCheck();
  const config = configService.get();
  if (!config.directRemoteEnabled || shuttingDown) return true;
  const { remoteControlDirectService } = await import('./remote-control-direct.service');
  const port = startedPort ?? remoteControlDirectService.getInfo()?.port;
  if (port === undefined) return true;
  const origin = config.directRemoteManagedTailscaleOrigin;
  if (!origin) {
    showProblem(remoteControlDirectService, null);
    return true;
  }

  try {
    await remoteControlTailscaleService.reconcile(origin, port, {
      previousLocalPort: previousServerPort ?? config.directRemotePort,
      // Quitting removes the route, and waits for this check to finish first.
      shouldApply: () => !shuttingDown,
    });
  } catch (err) {
    if (err instanceof TailscaleFunnelEnabledError) {
      logger.error('stopped remote control', { error: err.message });
      await remoteControlDirectService.stop();
      showProblem(remoteControlDirectService, err.message);
      scheduleStartRetry('retry');
      return false;
    }
    if (err instanceof TailscaleHttpsPortTakenError) {
      // Someone else's route now: taking the port back would cut them off. Look again later.
      logger.warn('left another Tailscale Serve route on the managed HTTPS port', {
        error: err.message,
      });
      showProblem(remoteControlDirectService, err.message);
      checkRouteSoon(ROUTE_CHECK_INTERVAL_MS);
      return true;
    }
    const retryInMs = nextDelay(routeAttempt++);
    logger.warn('failed to reconcile persisted Tailscale Serve listener', {
      error: String(err),
      retryInMs,
    });
    showProblem(
      remoteControlDirectService,
      `Remote control is on, but Tailscale Serve couldn't publish it: ${sentence(formatTailscaleError(err))} Komla keeps trying.`
    );
    checkRouteSoon(retryInMs);
    return true;
  }

  routeAttempt = 0;
  previousServerPort = undefined;
  showProblem(remoteControlDirectService, null);
  checkRouteSoon(ROUTE_CHECK_INTERVAL_MS);
  return true;
}

/** The route was just published from Settings: keep checking it from now on. */
export function watchPersistedTailscaleRoute(): void {
  checkRouteSoon(ROUTE_CHECK_INTERVAL_MS, true);
}

function checkRouteSoon(delayMs: number, resetBackoff = false): void {
  if (shuttingDown) return;
  if (resetBackoff) routeAttempt = 0;
  clearRouteCheck();
  routeCheckTimer = setTimeout(() => {
    routeCheckTimer = null;
    void withTailscaleRouteLock(() => ensureRoute()).catch((err: unknown) => {
      logger.warn('failed to check the persisted Tailscale Serve listener', {
        error: String(err),
      });
    });
  }, delayMs);
}

function scheduleStartRetry(reason: StartReason): void {
  if (shuttingDown) return;
  clearStartRetry();
  const retryInMs = nextDelay(startAttempt++);
  logger.info('retrying persisted direct remote-control server', { reason, retryInMs });
  startRetryTimer = setTimeout(() => {
    startRetryTimer = null;
    void startPersistedDirectRemoteServer('retry');
  }, retryInMs);
}

function showProblem(
  service: { setStartProblem(problem: string | null): void },
  problem: string | null
): void {
  problemShown = problem !== null;
  service.setStartProblem(problem);
}

function nextDelay(attempt: number): number {
  return RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sentence(message: string): string {
  return /[.!?]$/.test(message) ? message : `${message}.`;
}

function clearStartRetry(): void {
  if (startRetryTimer) clearTimeout(startRetryTimer);
  startRetryTimer = null;
}

function clearRouteCheck(): void {
  if (routeCheckTimer) clearTimeout(routeCheckTimer);
  routeCheckTimer = null;
}

function cancelTimers(): void {
  clearStartRetry();
  clearRouteCheck();
  startAttempt = 0;
  routeAttempt = 0;
}

/** Remote control was turned off: stop retrying and checking, and drop the problem shown. */
export function forgetPersistedDirectRemoteServer(): void {
  cancelTimers();
  previousServerPort = undefined;
  problemShown = false;
  void import('./remote-control-direct.service').then(({ remoteControlDirectService }) =>
    remoteControlDirectService.setStartProblem(null)
  );
}

/**
 * Retries taking down a route Komla set up when turning remote control off couldn't, since a
 * program that took the port would otherwise be on the tailnet with no Komla behind it.
 */
async function removeLeftoverTailscaleRoute(): Promise<void> {
  const origin = configService.get().directRemoteManagedTailscaleOrigin;
  if (!origin) return;
  try {
    await remoteControlTailscaleService.stop(origin, TAILSCALE_SHUTDOWN_TIMEOUT_MS);
  } catch (err) {
    logger.warn('failed to remove the Tailscale Serve listener left after turning off', {
      error: String(err),
    });
    return;
  }
  const config = configService.get();
  if (!config.directRemoteEnabled && config.directRemoteManagedTailscaleOrigin === origin) {
    configService.update({ directRemoteManagedTailscaleOrigin: undefined });
  }
}

export async function stopPersistedDirectRemoteServer(): Promise<void> {
  shuttingDown = true;
  cancelTimers();
  const config = configService.get();
  if (!config.directRemoteEnabled) {
    await removeLeftoverTailscaleRoute();
    return;
  }

  await startInFlight;
  await withTailscaleRouteLock(async () => {
    // Read again: publishing on another port may have finished while this waited its turn.
    const origin = configService.get().directRemoteManagedTailscaleOrigin;
    // While Komla is closed, any program that took the port would be on the
    // tailnet. The route stays in the config, and the next launch restores it.
    if (origin) {
      try {
        await remoteControlTailscaleService.stop(origin, TAILSCALE_SHUTDOWN_TIMEOUT_MS);
      } catch (err) {
        logger.warn('failed to remove the Tailscale Serve listener at shutdown', {
          error: String(err),
        });
      }
    }
    const { remoteControlDirectService } = await import('./remote-control-direct.service');
    await remoteControlDirectService.stop();
  });
}

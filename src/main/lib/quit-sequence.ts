/** One thing to stop or save at quit. A promise it returns is waited for. */
export type QuitStep = () => unknown;

export interface QuitPhase {
  name: string;
  /**
   * By name, as failures report them. They start together, in the order written, and the next
   * phase starts once all of them have settled.
   */
  steps: Readonly<Record<string, QuitStep>>;
}

/** Where the app is on its way out. */
export type QuitState =
  | { kind: 'running' }
  /** The user is being asked whether to quit. */
  | { kind: 'confirming' }
  | { kind: 'cleaning-up'; phase: string }
  /** Every phase is over and the app has been told to quit. */
  | { kind: 'done' };

export interface QuitStepFailure {
  phase: string;
  step: string;
  error: unknown;
}

export interface QuitSequence {
  state(): QuitState;
  /** Asks to quit. Only a running app takes it: one already on its way out carries on. */
  request(): void;
  /**
   * Whether a quit Electron is about to do goes ahead now. One before the phases are over waits
   * for them, except one asked for again while they run, which goes through so that a step that
   * never settles can't keep the app from quitting.
   */
  letsQuitThrough(): boolean;
  /**
   * The app itself will ask to quit once more while the phases run, and that quit waits for them
   * too. A macOS update does: it closes every window, which starts quitting, then quits again.
   */
  expectQuitFromApp(): void;
  /** The quit the app said it would ask for won't come, as when an update fails to install. */
  forgetQuitFromApp(): void;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === 'function';
}

/**
 * Quits the app in phases, each over before the next starts, so what must happen in order does.
 * A step that fails is reported and holds nothing up: the rest still run and the app still
 * quits. Phases whose steps are all synchronous run in the turn of the request.
 */
export function createQuitSequence(options: {
  /** Asks the user where quitting would lose something. False keeps the app running. */
  confirm: () => boolean;
  phases: readonly QuitPhase[];
  /** Quits the app, once every phase is over. */
  quit: () => void;
  onStepFailed: (failure: QuitStepFailure) => void;
}): QuitSequence {
  let state: QuitState = { kind: 'running' };
  let quitFromAppExpected = false;

  const report = (failure: QuitStepFailure): void => {
    try {
      options.onStepFailed(failure);
    } catch {
      // A report that fails holds nothing up either.
    }
  };

  /** Starts the phase's steps. Returns those still under way, which never reject. */
  const start = (phase: QuitPhase): Promise<void>[] => {
    const underWay: Promise<void>[] = [];
    for (const [step, run] of Object.entries(phase.steps)) {
      const failed = (error: unknown): void => report({ phase: phase.name, step, error });
      try {
        const result = run();
        if (isPromiseLike(result)) {
          underWay.push(Promise.resolve(result).then(() => undefined, failed));
        }
      } catch (error) {
        failed(error);
      }
    }
    return underWay;
  };

  const cleanUp = async (): Promise<void> => {
    for (const phase of options.phases) {
      state = { kind: 'cleaning-up', phase: phase.name };
      const underWay = start(phase);
      if (underWay.length > 0) await Promise.all(underWay);
    }
    state = { kind: 'done' };
    options.quit();
  };

  return {
    state: () => state,
    request() {
      if (state.kind !== 'running') return;
      state = { kind: 'confirming' };
      let confirmed = false;
      try {
        confirmed = options.confirm();
      } finally {
        if (!confirmed) {
          state = { kind: 'running' };
          quitFromAppExpected = false;
        }
      }
      if (confirmed) void cleanUp();
    },
    letsQuitThrough() {
      if (state.kind === 'done') return true;
      if (state.kind !== 'cleaning-up') return false;
      if (!quitFromAppExpected) return true;
      quitFromAppExpected = false;
      return false;
    },
    expectQuitFromApp() {
      quitFromAppExpected = true;
    },
    forgetQuitFromApp() {
      quitFromAppExpected = false;
    },
  };
}

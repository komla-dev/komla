import { onTestFinished } from 'vitest';

/**
 * Records the promise rejections nothing handled during the test. Node reports one after the
 * microtasks of the turn it rejected in, so check it after {@link settleRejections}.
 */
export function recordUnhandledRejections(): unknown[] {
  const reasons: unknown[] = [];
  const record = (reason: unknown) => reasons.push(reason);
  process.on('unhandledRejection', record);
  onTestFinished(() => {
    process.off('unhandledRejection', record);
  });
  return reasons;
}

/** Lets Node report the rejections left unhandled so far. */
export async function settleRejections(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

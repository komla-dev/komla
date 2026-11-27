import { describe, expect, it } from 'vitest';

import { automationSaveArgsSchema } from '../../../../src/shared/ipc/schemas/automation-ipc.schemas';

const base = {
  name: 'Daily summary',
  prompt: 'Summarize yesterday',
  target: { kind: 'local' },
  schedule: { cron: '0 9 * * *', timeZone: 'Europe/Oslo' },
  enabled: true,
  missedRunGraceMinutes: 720,
};

describe('automation IPC schemas', () => {
  it('saves runs that start in a project or in a Scratch workspace', () => {
    expect(automationSaveArgsSchema.safeParse([{ ...base, projectId: 'p1' }]).success).toBe(true);
    expect(automationSaveArgsSchema.safeParse([{ ...base, scratch: true }]).success).toBe(true);
  });

  it('refuses runs with both a project and a Scratch workspace, or neither', () => {
    for (const params of [base, { ...base, projectId: 'p1', scratch: true }]) {
      expect(automationSaveArgsSchema.safeParse([params]).success).toBe(false);
    }
  });

  it('refuses a branch to start from for Scratch runs, which have no repository', () => {
    expect(
      automationSaveArgsSchema.safeParse([{ ...base, scratch: true, startBranch: 'main' }]).success
    ).toBe(false);
  });
});

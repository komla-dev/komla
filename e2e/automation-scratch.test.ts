import path from 'path';

import { test as base, expect, SANDBOX_DIR, seedDefaultProject } from './electron-app';

const test = base.extend({
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    seedDefaultProject({ branchPrefix: 'automation-scratch/' });
    await provide();
  },
});

test.describe('Automations in Scratch workspaces', () => {
  test('a run starts in a new Scratch workspace outside any project', async ({ appWindow }) => {
    await expect(appWindow.getByRole('button', { name: 'New Workspace' }).first()).toBeVisible({
      timeout: 15_000,
    });
    // Settings loads lazily on first open; re-dispatch until it renders.
    await expect(async () => {
      await appWindow.evaluate(() =>
        window.dispatchEvent(new CustomEvent('open-settings', { detail: 'automations' }))
      );
      await expect(appWindow.getByRole('button', { name: 'New automation' }).first()).toBeVisible({
        timeout: 2_000,
      });
    }).toPass({ timeout: 15_000 });

    await appWindow.getByRole('button', { name: 'New automation' }).first().click();
    const editor = appWindow.getByRole('dialog', { name: 'New automation' });
    await editor.getByLabel('Name').fill('Daily summary');
    await editor.getByLabel('Prompt').fill('Summarize what happened yesterday.');
    await editor.getByLabel('Project').click();
    await appWindow.getByRole('menuitem', { name: 'Scratch workspace' }).click();
    await expect(editor.getByLabel('Project')).toHaveText('Scratch workspace');
    await editor.getByRole('button', { name: /Create automation/ }).click();
    await expect(editor).toHaveCount(0);

    await appWindow.getByRole('button', { name: 'Run Daily summary now' }).click();

    await expect
      .poll(async () =>
        appWindow.evaluate(async () => (await window.api.getWorkspaces()).filter((w) => w.scratch))
      )
      .toHaveLength(1);
    const [workspace] = await appWindow.evaluate(async () =>
      (await window.api.getWorkspaces()).filter((w) => w.scratch)
    );
    expect(workspace).toMatchObject({ customName: 'Daily summary', projectId: null });
    expect(path.dirname(workspace!.workingDirectory)).toBe(path.join(SANDBOX_DIR, 'scratch'));
  });
});

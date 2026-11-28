import fs from 'fs';
import path from 'path';

import { test as base, expect, seedDefaultProject } from './electron-app';

const ORIGINAL = ['const total = 1;', '', 'call(a);', '', 'done();', ''].join('\n');
const MODIFIED = [
  // A word changed within a line.
  'const count = 1;',
  '',
  // One line replaced by several, which Monaco marks as a single change across lines.
  'call(a, b,',
  '  c,',
  '  d);',
  '',
  'done();',
  '',
  // A wholly added block.
  'function added() {',
  '  return 1;',
  '}',
  '',
].join('\n');

const test = base.extend({
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    seedDefaultProject({
      branchPrefix: 'word-marks/',
      initialFile: { name: 'code.ts', content: ORIGINAL },
    });
    await provide();
  },
});

test('the diff marks changed words strongly but not lines added end to end', async ({
  appWindow,
}) => {
  test.setTimeout(90_000);
  await expect(appWindow.getByRole('button', { name: 'New Workspace' }).first()).toBeVisible({
    timeout: 15_000,
  });
  const expand = appWindow.getByRole('button', { name: 'Expand sidebar' });
  if (await expand.isVisible()) await expand.click();
  await appWindow.getByRole('button', { name: 'New Workspace' }).first().click();
  const create = appWindow.getByRole('dialog', { name: 'Create Workspace' });
  await create.locator('input[placeholder$="swift-fox"]').fill('marks');
  await create.getByRole('button', { name: /^(Launch|Create)/ }).click();
  await expect(appWindow.getByRole('button', { name: 'Toggle file panel' })).toBeVisible({
    timeout: 20_000,
  });

  const workingDirectory = await appWindow.evaluate(async () => {
    const [workspace] = await window.api.getWorkspaces();
    return workspace.workingDirectory;
  });
  fs.writeFileSync(path.join(workingDirectory, 'code.ts'), MODIFIED);

  // The full-window diff viewer (Cmd+Shift+G on macOS, Ctrl+Shift+D elsewhere).
  await appWindow.keyboard.press(
    process.platform === 'darwin' ? 'Meta+Shift+G' : 'Control+Shift+D'
  );
  const dialog = appWindow.getByRole('dialog').filter({ has: appWindow.getByRole('tree') });
  const modified = dialog.locator('.monaco-diff-editor .editor.modified');
  // The word change, the change across lines and the added block each draw their marks.
  await expect
    .poll(() => modified.locator('.view-overlays .cdr.char-insert').count(), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(6);

  // Each added-text mark: how opaque its color is, and whether it covers its line from the left
  // edge to the right one.
  const marks = await modified.evaluate((editor) =>
    Array.from(editor.querySelectorAll<HTMLElement>('.view-overlays .cdr.char-insert')).map(
      (mark) => {
        const color = getComputedStyle(mark).backgroundColor;
        const alpha = /^rgba\(.*,\s*([\d.]+)\)$/.exec(color);
        const line = mark.parentElement!.getBoundingClientRect();
        const box = mark.getBoundingClientRect();
        return {
          alpha: alpha ? Number(alpha[1]) : 1,
          wholeLine: box.left - line.left < 1 && box.width >= line.width - 1,
        };
      }
    )
  );
  const strong = marks.filter((mark) => mark.alpha > 0.15);
  // A changed word stands out from the code around it.
  expect(strong.length).toBeGreaterThan(0);
  // A line added end to end is tinted by the line color alone, not filled with the word color.
  expect(strong.filter((mark) => mark.wholeLine)).toEqual([]);
  expect(marks.filter((mark) => mark.wholeLine).length).toBeGreaterThanOrEqual(4);
});

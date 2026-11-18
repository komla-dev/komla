import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  discardPath,
  emptyDiscardDir,
  removePathInChild,
} from '../../../src/main/lib/remove-path';

describe('removePathInChild', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'komla-remove-in-child-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('removes a directory tree', async () => {
    const tree = join(root, 'node_modules');
    mkdirSync(join(tree, 'pkg', 'lib'), { recursive: true });
    writeFileSync(join(tree, 'pkg', 'lib', 'index.js'), 'x');
    writeFileSync(join(tree, 'top.js'), 'x');

    await removePathInChild(tree);

    expect(existsSync(tree)).toBe(false);
    expect(existsSync(root)).toBe(true);
  });

  it('removes a single file', async () => {
    const file = join(root, 'file.txt');
    writeFileSync(file, 'x');

    await removePathInChild(file);

    expect(existsSync(file)).toBe(false);
  });

  it('succeeds when the path is already gone', async () => {
    await expect(removePathInChild(join(root, 'missing'))).resolves.toBeUndefined();
  });

  it('keeps a path with spaces and shell characters intact', async () => {
    const tree = join(root, 'my deps; echo $HOME');
    mkdirSync(tree);
    writeFileSync(join(tree, 'a.js'), 'x');
    writeFileSync(join(root, 'sibling.txt'), 'x');

    await removePathInChild(tree);

    expect(existsSync(tree)).toBe(false);
    expect(existsSync(join(root, 'sibling.txt'))).toBe(true);
  });

  it("ignores the app's NODE_OPTIONS, which could load other code into the delete", async () => {
    const tree = join(root, 'node_modules');
    mkdirSync(tree);
    const previous = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = `--require ${join(root, 'does-not-exist.js')}`;
    try {
      await removePathInChild(tree);
    } finally {
      if (previous === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previous;
    }

    expect(existsSync(tree)).toBe(false);
  });
});

describe('discardPath', () => {
  let root: string;
  let discardDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'komla-discard-'));
    discardDir = join(root, '.discarded');
  });

  afterEach(async () => {
    // A delete may still be finishing in the background.
    await vi.waitFor(
      () => expect(existsSync(discardDir) ? readdirSync(discardDir) : []).toEqual([]),
      { timeout: 10_000 }
    );
    rmSync(root, { recursive: true, force: true });
  }, 20_000);

  it('frees the path at once and deletes the tree afterwards', async () => {
    const tree = join(root, 'project', 'branch');
    mkdirSync(join(tree, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(tree, 'node_modules', 'pkg', 'index.js'), 'x');
    writeFileSync(join(root, 'project', 'sibling.txt'), 'x');

    await discardPath(tree, discardDir);

    expect(existsSync(tree)).toBe(false);
    expect(existsSync(join(root, 'project', 'sibling.txt'))).toBe(true);
    await vi.waitFor(() => expect(readdirSync(discardDir)).toEqual([]), { timeout: 10_000 });
  });

  it('frees the same path twice, as a copy made again and removed again does', async () => {
    const tree = join(root, 'branch');
    mkdirSync(tree);
    await discardPath(tree, discardDir);
    mkdirSync(tree);
    await discardPath(tree, discardDir);

    expect(existsSync(tree)).toBe(false);
  });

  it('succeeds when a file stands where a folder on the path should be', async () => {
    writeFileSync(join(root, 'file'), 'x');

    await expect(discardPath(join(root, 'file', 'branch'), discardDir)).resolves.toBeUndefined();
  });

  it('succeeds when the path is already gone, making no discard folder', async () => {
    await expect(discardPath(join(root, 'missing'), discardDir)).resolves.toBeUndefined();
    expect(existsSync(discardDir)).toBe(false);
  });
});

describe('emptyDiscardDir', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'komla-discard-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('deletes trees an earlier run left in the discard folder', async () => {
    const discardDir = join(root, '.discarded');
    mkdirSync(join(discardDir, 'branch-1a2b', 'node_modules'), { recursive: true });
    writeFileSync(join(discardDir, 'branch-1a2b', 'node_modules', 'a.js'), 'x');

    await emptyDiscardDir(discardDir);

    await vi.waitFor(() => expect(readdirSync(discardDir)).toEqual([]), { timeout: 10_000 });
  });

  it('does nothing when there is no discard folder', async () => {
    await expect(emptyDiscardDir(join(root, 'missing'))).resolves.toBeUndefined();
  });

  it('skips the deletes it queued once stopped', async () => {
    const discardDir = join(root, '.discarded');
    mkdirSync(join(discardDir, 'first-1a2b'), { recursive: true });
    mkdirSync(join(discardDir, 'second-3c4d'), { recursive: true });
    // Asked once per tree while queueing, then once per tree before its delete.
    let asked = 0;

    await emptyDiscardDir(discardDir, () => asked++ >= 2);
    // Deletes run in turn, so this one goes only after the skipped ones.
    const later = join(root, 'later');
    mkdirSync(later);
    await discardPath(later, discardDir);
    await vi.waitFor(
      () => expect(readdirSync(discardDir).sort()).toEqual(['first-1a2b', 'second-3c4d']),
      { timeout: 10_000 }
    );
  });

  it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)(
    'goes on deleting after a delete whose failure report throws',
    async () => {
      const discardDir = join(root, '.discarded');
      const stuck = join(discardDir, 'stuck-1a2b');
      mkdirSync(join(stuck, 'locked'), { recursive: true });
      writeFileSync(join(stuck, 'locked', 'a.js'), 'x');
      chmodSync(join(stuck, 'locked'), 0o500);
      try {
        const report = vi.fn(() => {
          throw new Error('report failed');
        });
        await emptyDiscardDir(discardDir, undefined, report);
        const later = join(root, 'later');
        mkdirSync(later);
        await discardPath(later, discardDir);

        await vi.waitFor(() => expect(readdirSync(discardDir)).toEqual(['stuck-1a2b']), {
          timeout: 10_000,
        });
        expect(report).toHaveBeenCalledWith(stuck, expect.any(Error));
      } finally {
        chmodSync(join(stuck, 'locked'), 0o700);
      }
    },
    20_000
  );

  it('deletes nothing once stopped', async () => {
    const discardDir = join(root, '.discarded');
    mkdirSync(join(discardDir, 'branch-1a2b'), { recursive: true });

    await emptyDiscardDir(discardDir, () => true);

    expect(readdirSync(discardDir)).toEqual(['branch-1a2b']);
  });
});

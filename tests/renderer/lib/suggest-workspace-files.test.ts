import { describe, expect, it } from 'vitest';

import { suggestWorkspaceFiles } from '../../../src/renderer/lib/suggest-workspace-files';

const files = [
  'README.md',
  'src/main.ts',
  'packages/app/src/main.ts',
  'packages/app/src/lib/paths.ts',
  'packages/web/src/index.ts',
  'packages/app/src/index.ts',
  'docs/setup.md',
];

describe('suggestWorkspaceFiles', () => {
  it('finds the file a path printed from a folder inside the workspace meant', () => {
    expect(suggestWorkspaceFiles([files], 'src/lib/paths.ts')).toEqual({
      paths: ['packages/app/src/lib/paths.ts'],
      whole: true,
    });
    expect(suggestWorkspaceFiles([files], './paths.ts')).toEqual({
      paths: ['packages/app/src/lib/paths.ts'],
      whole: true,
    });
  });

  it('lists every file that ends with the path, the ones in the fewest folders first', () => {
    expect(suggestWorkspaceFiles([files], 'src/index.ts')).toEqual({
      paths: ['packages/app/src/index.ts', 'packages/web/src/index.ts'],
      whole: true,
    });
  });

  it('prefers the files that share the most of the path, and says when that is not all of it', () => {
    expect(suggestWorkspaceFiles([files], 'old/app/src/main.ts')).toEqual({
      paths: ['packages/app/src/main.ts'],
      whole: false,
    });
    expect(suggestWorkspaceFiles([files], 'guides/setup.md')).toEqual({
      paths: ['docs/setup.md'],
      whole: false,
    });
  });

  it('suggests nothing for a listed path, or one no file is named like', () => {
    expect(suggestWorkspaceFiles([files], 'src/main.ts').paths).toEqual([]);
    expect(suggestWorkspaceFiles([files], 'src/ain.ts').paths).toEqual([]);
    expect(suggestWorkspaceFiles([files], '').paths).toEqual([]);
  });

  it('reads every list given, each file once', () => {
    expect(suggestWorkspaceFiles([files, ['dist/setup.md', 'docs/setup.md']], 'setup.md')).toEqual({
      paths: ['dist/setup.md', 'docs/setup.md'],
      whole: true,
    });
  });
});

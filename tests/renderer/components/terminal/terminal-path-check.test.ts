import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  forgetTerminalPathChecks,
  terminalLinkTargetsExist,
} from '../../../../src/renderer/components/terminal/terminal-path-check';
import { useFileListStore } from '../../../../src/renderer/stores/file-list.store';

import type { TerminalFileLinkContext } from '../../../../src/renderer/components/terminal/TerminalView';

const context: TerminalFileLinkContext = {
  workspaceId: 'ws',
  workspaceRoot: '/repo/',
  workingDirectory: '/repo/',
  workspaceBackendKind: 'local',
};

describe('terminalLinkTargetsExist', () => {
  const terminalFilesExist = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    forgetTerminalPathChecks();
    terminalFilesExist.mockReset();
    terminalFilesExist.mockImplementation(async (_w: string, _t: string, paths: string[]) =>
      paths.map((path) => path.includes('there'))
    );
    vi.stubGlobal('window', { api: { terminalFilesExist } });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('checks each target where its terminal runs, a workspace path from its root', async () => {
    const found = await terminalLinkTargetsExist('t1', context, [
      { type: 'external', fullPath: '~/there' },
      null,
      { type: 'workspace', filePath: 'bin/there' },
      { type: 'external', fullPath: '/tmp/gone' },
    ]);

    expect(found).toEqual([true, false, true, false]);
    expect(terminalFilesExist).toHaveBeenCalledExactlyOnceWith('ws', 't1', [
      '~/there',
      '/repo/bin/there',
      '/tmp/gone',
    ]);
  });

  it('holds an answer for a while, per terminal, and asks once for a path asked twice', async () => {
    const target = { type: 'external', fullPath: '/tmp/there' } as const;
    await Promise.all([
      terminalLinkTargetsExist('t1', context, [target, target]),
      terminalLinkTargetsExist('t1', context, [target]),
    ]);
    expect(terminalFilesExist).toHaveBeenCalledExactlyOnceWith('ws', 't1', ['/tmp/there']);

    await terminalLinkTargetsExist('t2', context, [target]);
    expect(terminalFilesExist).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(11_000);
    expect(await terminalLinkTargetsExist('t1', context, [target])).toEqual([true]);
    expect(terminalFilesExist).toHaveBeenCalledTimes(3);
  });

  it('takes a path for not there when the check fails or has no answer, and asks again', async () => {
    const target = { type: 'external', fullPath: '/tmp/there' } as const;
    terminalFilesExist.mockRejectedValueOnce(new Error('offline'));
    expect(await terminalLinkTargetsExist('t1', context, [target])).toEqual([false]);
    terminalFilesExist.mockResolvedValueOnce([null]);
    expect(await terminalLinkTargetsExist('t1', context, [target])).toEqual([false]);
    expect(await terminalLinkTargetsExist('t1', context, [target])).toEqual([true]);
  });

  it('does not ask about a path too long to send, or without a workspace', async () => {
    const long = {
      type: 'external',
      fullPath: `/${'a'.repeat(4096)}`,
    } as const;
    expect(await terminalLinkTargetsExist('t1', context, [long])).toEqual([false]);
    expect(
      await terminalLinkTargetsExist('t1', { ...context, workspaceId: undefined }, [
        { type: 'external', fullPath: '/tmp/there' },
      ])
    ).toEqual([false]);
    expect(terminalFilesExist).not.toHaveBeenCalled();
  });

  it('goes by the file list for a workspace on a Windows drive', async () => {
    const root = 'C:\\repo';
    vi.spyOn(useFileListStore.getState(), 'getFileList').mockReturnValue({
      files: ['bin/run', 'src/app/main'],
      gitIgnoredFiles: [],
      emptyDirs: ['empty/dir'],
      isLoading: false,
    } as unknown as ReturnType<ReturnType<typeof useFileListStore.getState>['getFileList']>);

    expect(
      await terminalLinkTargetsExist(
        't1',
        { ...context, workspaceRoot: root, workingDirectory: root },
        ['bin/run', 'src/app', 'empty/dir', 'src/ap', 'bin/missing'].map((filePath) => ({
          type: 'workspace' as const,
          filePath,
        }))
      )
    ).toEqual([true, true, true, false, false]);
    expect(terminalFilesExist).not.toHaveBeenCalled();
  });
});

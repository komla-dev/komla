import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  queuePrintedFileHyperlink,
  takeQueuedFileHyperlinks,
  useTerminalFilesStore,
  type TerminalFilePrint,
} from '@/stores/terminal-files.store';

const context = { workspaceId: 'ws-1', workspaceBackendKind: 'local' as const };

function printed(fullPath: string, printedAt?: number, terminalId = 't1'): TerminalFilePrint {
  return { path: fullPath, terminalId, target: { type: 'external', fullPath }, context, printedAt };
}

afterEach(() => {
  vi.restoreAllMocks();
  useTerminalFilesStore.setState(useTerminalFilesStore.getInitialState(), true);
});

describe('terminal-files.store', () => {
  it('keeps files in the order printed, the latest first, untimed ones last', () => {
    vi.spyOn(Date, 'now').mockReturnValue(100);
    const { notePrinted, noteOpened } = useTerminalFilesStore.getState();
    // One read of a terminal, newest line first, all written in one go.
    notePrinted('ws-1', [printed('/tmp/b.md', 50), printed('/tmp/c.md', 50)]);
    // A later read finds a line written in the same go, so below the others.
    notePrinted('ws-1', [printed('/tmp/a.md', 50)]);
    notePrinted('ws-1', [printed('/tmp/untimed.md'), printed('/tmp/old.md', 5)]);
    // Opening a file leaves it where it was printed.
    noteOpened('ws-1', printed('/tmp/c.md'));

    expect(useTerminalFilesStore.getState().byWorkspace['ws-1'].map((f) => f.path)).toEqual([
      '/tmp/a.md',
      '/tmp/b.md',
      '/tmp/c.md',
      '/tmp/old.md',
      '/tmp/untimed.md',
    ]);
  });

  it('keeps each file once, at the latest time it was printed', () => {
    const { notePrinted } = useTerminalFilesStore.getState();
    notePrinted('ws-1', [printed('/tmp/a.png', 20), printed('/tmp/a.png', 10)]);
    notePrinted('ws-1', [printed('/tmp/a.png'), printed('/tmp/a.png', 30)]);
    // The same path in another terminal can be another machine's file.
    notePrinted('ws-1', [printed('/tmp/a.png', 5, 't2')]);

    expect(
      useTerminalFilesStore
        .getState()
        .byWorkspace['ws-1'].map(({ terminalId, printedAt }) => [terminalId, printedAt])
    ).toEqual([
      ['t1', 30],
      ['t2', 5],
    ]);
  });

  it('keeps when an opened file was printed', () => {
    vi.spyOn(Date, 'now').mockReturnValue(100);
    const { notePrinted, noteOpened } = useTerminalFilesStore.getState();
    notePrinted('ws-1', [printed('/tmp/a.png', 20)]);
    noteOpened('ws-1', { ...printed('/tmp/a.png'), lineNumber: 3 });

    expect(useTerminalFilesStore.getState().byWorkspace['ws-1']).toEqual([
      { ...printed('/tmp/a.png', 20), lineNumber: 3, openedAt: 100 },
    ]);
  });

  it('makes a file a read found to be a folder the folder, once', () => {
    vi.spyOn(Date, 'now').mockReturnValue(100);
    const { notePrinted, noteOpened, noteChecked, noteFolder } = useTerminalFilesStore.getState();
    notePrinted('ws-1', [printed('/tmp/hedge', 30), printed('/tmp/a.png', 20)]);
    // A check took it for a file, which isn't there.
    const [hedge] = useTerminalFilesStore.getState().byWorkspace['ws-1'];
    noteChecked('ws-1', new Map([[hedge, false]]));
    noteFolder('ws-1', 'terminal:t1:/tmp/hedge');

    expect(useTerminalFilesStore.getState().byWorkspace['ws-1']).toEqual([
      printed('/tmp/hedge/', 30),
      printed('/tmp/a.png', 20),
    ]);

    // Printed or opened without its slash again, it is the folder.
    notePrinted('ws-1', [printed('/tmp/hedge', 40)]);
    noteOpened('ws-1', { ...printed('/tmp/hedge'), lineNumber: 2 });
    expect(useTerminalFilesStore.getState().byWorkspace['ws-1']).toEqual([
      { ...printed('/tmp/hedge/', 40), openedAt: 100 },
      printed('/tmp/a.png', 20),
    ]);
  });

  it('takes the terminal of the later print when merging a workspace folder', () => {
    const { notePrinted, noteFolder } = useTerminalFilesStore.getState();
    const inWorkspace = (filePath: string, printedAt: number, terminalId: string) => ({
      path: filePath,
      terminalId,
      target: { type: 'workspace' as const, filePath },
      context,
      printedAt,
    });
    notePrinted('ws-1', [inWorkspace('src/hedge', 10, 't1'), inWorkspace('src/hedge/', 30, 't2')]);
    noteFolder('ws-1', 'workspace:src/hedge');

    expect(useTerminalFilesStore.getState().byWorkspace['ws-1']).toEqual([
      inWorkspace('src/hedge/', 30, 't2'),
    ]);
    // Known already, with nothing to merge, it changes nothing.
    const { byWorkspace, foldersByWorkspace } = useTerminalFilesStore.getState();
    noteFolder('ws-1', 'workspace:src/hedge');
    expect(useTerminalFilesStore.getState().byWorkspace).toBe(byWorkspace);
    expect(useTerminalFilesStore.getState().foldersByWorkspace).toBe(foldersByWorkspace);
  });

  it('merges a folder printed both with its slash and without, at the latest of either', () => {
    vi.spyOn(Date, 'now').mockReturnValue(100);
    const { notePrinted, noteOpened, noteFolder } = useTerminalFilesStore.getState();
    notePrinted('ws-1', [printed('/tmp/hedge/', 10), printed('/tmp/a.png', 20)]);
    notePrinted('ws-1', [printed('/tmp/hedge', 30)]);
    noteOpened('ws-1', printed('/tmp/hedge'));
    noteFolder('ws-1', 'terminal:t1:/tmp/hedge');

    expect(useTerminalFilesStore.getState().byWorkspace['ws-1']).toEqual([
      { ...printed('/tmp/hedge/', 30), openedAt: 100 },
      printed('/tmp/a.png', 20),
    ]);
  });

  it('drops the files seen longest ago past 200 per workspace', () => {
    const prints = Array.from({ length: 201 }, (_, i) => printed(`/tmp/${i}.png`, i));
    useTerminalFilesStore.getState().notePrinted('ws-1', prints);

    const files = useTerminalFilesStore.getState().byWorkspace['ws-1'];
    expect(files).toHaveLength(200);
    expect(files.some((file) => file.path === '/tmp/0.png')).toBe(false);
  });

  it('keeps opened files however many files are printed after them', () => {
    vi.spyOn(Date, 'now').mockReturnValue(100);
    const { notePrinted, noteOpened } = useTerminalFilesStore.getState();
    noteOpened('ws-1', printed('/tmp/opened.png'));
    // A test run or a stack trace prints a lot of paths, most of which the list never shows.
    notePrinted(
      'ws-1',
      Array.from({ length: 250 }, (_, i) => printed(`/tmp/${i}.png`, 200 + i))
    );

    const files = useTerminalFilesStore.getState().byWorkspace['ws-1'];
    expect(files).toHaveLength(200);
    expect(files.some((file) => file.path === '/tmp/opened.png')).toBe(true);
    // Still in the order printed, the opened one, never printed, last.
    expect(files[0].path).toBe('/tmp/249.png');
    expect(files.at(-1)!.path).toBe('/tmp/opened.png');
  });

  it('takes the line and terminal of the latest print of a file', () => {
    const workspaceFile = (lineNumber: number, terminalId: string, printedAt: number) => ({
      path: 'src/app.ts',
      lineNumber,
      terminalId,
      target: { type: 'workspace' as const, filePath: 'src/app.ts' },
      context,
      printedAt,
    });
    const { notePrinted } = useTerminalFilesStore.getState();
    notePrinted('ws-1', [workspaceFile(10, 't1', 10)]);
    notePrinted('ws-1', [workspaceFile(250, 't2', 20), workspaceFile(5, 't1', 15)]);

    expect(useTerminalFilesStore.getState().byWorkspace['ws-1']).toEqual([
      workspaceFile(250, 't2', 20),
    ]);
  });

  it('holds each hyperlinked file once, however often a redraw prints it', () => {
    queuePrintedFileHyperlink('ws-1', printed('/tmp/b.png', 1));
    for (let i = 0; i < 600; i++) queuePrintedFileHyperlink('ws-1', printed('/tmp/a.png', 2 + i));

    expect(takeQueuedFileHyperlinks('ws-1')).toEqual([
      printed('/tmp/a.png', 601),
      printed('/tmp/b.png', 1),
    ]);
    expect(takeQueuedFileHyperlinks('ws-1')).toEqual([]);
  });
});

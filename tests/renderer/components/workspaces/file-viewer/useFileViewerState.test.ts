// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  computeLargeFileBlock,
  isFileViewerActive,
  LARGE_FILE_LINE_THRESHOLD,
  shouldReloadSelectedDiffContent,
  useFileEditorState,
} from '../../../../../src/renderer/components/workspaces/file-viewer/useFileViewerState';

describe('useFileViewerState helpers', () => {
  beforeEach(() => {
    Object.assign(window, {
      api: {
        readWorkspaceFile: vi.fn(),
        readWorkspaceImageFile: vi.fn(),
        readFile: vi.fn(),
        readImageFile: vi.fn(),
        getViewerPreviewUrl: vi.fn(),
        getMediaFileMetadata: vi.fn(),
      },
    });
  });

  it('loads SSH text files through the workspace API', async () => {
    vi.mocked(window.api.readWorkspaceFile).mockResolvedValue('remote content');
    const { result } = renderHook(() => useFileEditorState('ssh://dev/repo', 'ws-ssh'));

    await act(() => result.current.openFile('src/app.ts'));

    expect(window.api.readWorkspaceFile).toHaveBeenCalledWith('ws-ssh', 'src/app.ts');
    expect(window.api.readFile).not.toHaveBeenCalled();
    expect(result.current.fileContent).toBe('remote content');
  });

  it('loads SSH images through the workspace API', async () => {
    vi.mocked(window.api.readWorkspaceImageFile).mockResolvedValue({
      data: 'aW1hZ2U=',
      mimeType: 'image/png',
    });
    const { result } = renderHook(() => useFileEditorState('ssh://dev/repo', 'ws-ssh'));

    await act(() => result.current.openFile('logo.png'));

    await waitFor(() => expect(result.current.isImage).toBe(true));
    expect(window.api.readWorkspaceImageFile).toHaveBeenCalledWith('ws-ssh', 'logo.png');
    expect(result.current.imageMimeType).toBe('image/png');
  });

  it('streams SSH media from the host without local filesystem APIs', async () => {
    vi.mocked(window.api.getViewerPreviewUrl).mockResolvedValue('komla-preview://t/demo.mp4');
    const { result } = renderHook(() => useFileEditorState('ssh://dev/repo', 'ws-ssh'));

    await act(() => result.current.openFile('demo.mp4'));

    expect(result.current).toMatchObject({
      error: null,
      isMedia: true,
      mediaUrl: 'komla-preview://t/demo.mp4',
      mediaKind: 'video',
    });
    expect(window.api.getViewerPreviewUrl).toHaveBeenCalledWith('ws-ssh', null, {
      kind: 'workspace',
      filePath: 'demo.mp4',
    });
    expect(window.api.getMediaFileMetadata).not.toHaveBeenCalled();
    expect(window.api.readFile).not.toHaveBeenCalled();
  });

  it('streams local media and versions it by its metadata', async () => {
    vi.mocked(window.api.getViewerPreviewUrl).mockResolvedValue('komla-preview://t/song.mp3');
    vi.mocked(window.api.getMediaFileMetadata).mockResolvedValue({
      mimeType: 'audio/mpeg',
      kind: 'audio',
      size: 80 * 1024 * 1024,
      mtimeMs: 7,
    });
    const { result } = renderHook(() => useFileEditorState('/repo', 'ws-local'));

    await act(() => result.current.openFile('song.mp3'));

    expect(result.current).toMatchObject({
      mediaUrl: 'komla-preview://t/song.mp3',
      mediaKind: 'audio',
      diskContent: `${80 * 1024 * 1024}:7`,
    });
  });

  it('says why SSH media could not stream', async () => {
    vi.mocked(window.api.getViewerPreviewUrl).mockRejectedValue(
      new Error("ENOENT: no such file or directory, 'demo.mp4'")
    );
    const { result } = renderHook(() => useFileEditorState('ssh://dev/repo', 'ws-ssh'));

    await act(() => result.current.openFile('demo.mp4'));

    expect(result.current.missingOnDisk).toBe(true);
  });

  describe('isFileViewerActive', () => {
    it('returns false when the viewer is disabled even if it is open', () => {
      expect(isFileViewerActive(true, false)).toBe(false);
    });

    it('returns true only when the viewer is both open and enabled', () => {
      expect(isFileViewerActive(true, true)).toBe(true);
      expect(isFileViewerActive(false, true)).toBe(false);
    });
  });

  describe('computeLargeFileBlock', () => {
    it('returns null when no FileChange is provided', () => {
      expect(computeLargeFileBlock(undefined, false)).toBeNull();
    });

    it('returns null for small diffs', () => {
      expect(computeLargeFileBlock({ additions: 50, deletions: 100 }, false)).toBeNull();
    });

    it('blocks when combined line count exceeds the threshold', () => {
      const lines = LARGE_FILE_LINE_THRESHOLD + 1;
      expect(computeLargeFileBlock({ additions: lines, deletions: 0 }, false)).toEqual({ lines });
    });

    it('counts deletions toward the threshold (e.g. deleted package-lock.json)', () => {
      const lines = LARGE_FILE_LINE_THRESHOLD + 5000;
      expect(computeLargeFileBlock({ additions: 0, deletions: lines }, false)).toEqual({ lines });
    });

    it('returns null once the user has opted in via Load Anyway', () => {
      const lines = LARGE_FILE_LINE_THRESHOLD * 5;
      expect(computeLargeFileBlock({ additions: lines, deletions: 0 }, true)).toBeNull();
    });

    it('respects a custom threshold', () => {
      expect(computeLargeFileBlock({ additions: 100, deletions: 50 }, false, 200)).toBeNull();
      expect(computeLargeFileBlock({ additions: 100, deletions: 150 }, false, 200)).toEqual({
        lines: 250,
      });
    });
  });

  describe('shouldReloadSelectedDiffContent', () => {
    it('does not reload stale diff content while the viewer is inactive', () => {
      expect(
        shouldReloadSelectedDiffContent({
          open: false,
          selectedFile: 'src/app.ts',
          fileContent: {
            path: 'src/app.ts',
            oldContent: 'before\n',
            newContent: 'after\n',
            status: 'modified',
            isBinary: false,
          },
          isStale: true,
          loadingFile: false,
          fileError: null,
        })
      ).toBe(false);
    });

    it('reloads stale diff content once the viewer is active again', () => {
      expect(
        shouldReloadSelectedDiffContent({
          open: true,
          selectedFile: 'src/app.ts',
          fileContent: {
            path: 'src/app.ts',
            oldContent: 'before\n',
            newContent: 'after\n',
            status: 'modified',
            isBinary: false,
          },
          isStale: true,
          loadingFile: false,
          fileError: null,
        })
      ).toBe(true);
    });
  });
});

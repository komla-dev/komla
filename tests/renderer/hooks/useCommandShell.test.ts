// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useCommandShell } from '../../../src/renderer/hooks/useCommandShell';
import { useConfigStore } from '../../../src/renderer/stores/config.store';

import type { AppConfig } from '../../../src/renderer/types';
import type { CommandShell } from '../../../src/shared/types';

const getCommandShell = vi.fn<() => Promise<CommandShell>>();

describe('useCommandShell', () => {
  beforeEach(() => {
    getCommandShell.mockReset();
    Object.assign(window, { api: { getCommandShell } });
    useConfigStore.setState({ config: { shellMode: 'powershell' } as AppConfig });
  });

  it('shows the shell the main process names', async () => {
    getCommandShell.mockResolvedValue({ kind: 'powershell', name: 'PowerShell 7' });

    const { result } = renderHook(() => useCommandShell());

    expect(result.current).toBeUndefined();
    await waitFor(() => expect(result.current?.name).toBe('PowerShell 7'));
  });

  it('asks again once the user switches to WSL', async () => {
    getCommandShell.mockResolvedValueOnce({
      kind: 'windows-powershell',
      name: 'Windows PowerShell 5.1',
    });
    getCommandShell.mockResolvedValueOnce({ kind: 'wsl', name: 'WSL (Ubuntu)' });
    const { result } = renderHook(() => useCommandShell());
    await waitFor(() => expect(result.current?.name).toBe('Windows PowerShell 5.1'));

    act(() => {
      useConfigStore.setState({ config: { shellMode: 'wsl', wslDistro: 'Ubuntu' } as AppConfig });
    });

    // The old shell doesn't show while the new one is looked up.
    expect(result.current).toBeUndefined();
    await waitFor(() => expect(result.current?.name).toBe('WSL (Ubuntu)'));
  });
});

import { useEffect, useState } from 'react';

import { useConfigStore } from '@/stores/config.store';

import type { CommandShell } from '@/types';

/**
 * The shell Terminal Commands and Setup steps run in on this computer, once it's known. It's
 * asked for each time an editor shows it; the main process keeps the answer for a minute, so a
 * newly installed pwsh shows here as soon as new terminals use it.
 */
export function useCommandShell(): CommandShell | undefined {
  const shellMode = useConfigStore((s) => s.config?.shellMode);
  const wslDistro = useConfigStore((s) => s.config?.wslDistro);
  const key = `${shellMode ?? ''}\n${wslDistro ?? ''}`;
  const [shell, setShell] = useState<{ key: string; shell: CommandShell }>();

  useEffect(() => {
    let current = true;
    window.api.getCommandShell().then(
      (found) => current && setShell({ key, shell: found }),
      () => {}
    );
    return () => {
      current = false;
    };
  }, [key]);

  return shell?.key === key ? shell.shell : undefined;
}

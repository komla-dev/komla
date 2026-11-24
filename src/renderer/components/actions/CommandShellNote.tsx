import { useCommandShell } from '@/hooks/useCommandShell';
import { cn } from '@/lib/utils';

import type { CommandShell } from '@/types';

/** Where a command can run: this computer, an SSH host, or either, by workspace. */
export type CommandRunsOn = 'this-computer' | 'ssh-host' | 'either';

/** Which shell runs a command, and for PowerShell what a POSIX command misses there. */
export function describeCommandShell(
  shell: CommandShell | undefined,
  runsOn: CommandRunsOn
): string | null {
  if (runsOn === 'ssh-host') return "Runs in the SSH host's shell.";
  if (!shell) return null;
  const sentence =
    runsOn === 'either'
      ? `Runs in ${shell.name} on this computer, and in the SSH host's shell in SSH workspaces.`
      : `Runs in ${shell.name}.`;
  if (shell.kind === 'windows-powershell') {
    return `${sentence} Windows PowerShell has no &&, and its cp, mv and rm are cmdlets without their Unix options.`;
  }
  if (shell.kind === 'powershell') {
    return `${sentence} In PowerShell, cp, mv and rm are cmdlets without their Unix options.`;
  }
  return sentence;
}

/** The shell a Terminal Command or Setup step runs in, once it's known. */
export function CommandShellNote({
  runsOn,
  className,
}: {
  runsOn: CommandRunsOn;
  className?: string;
}) {
  const description = describeCommandShell(useCommandShell(), runsOn);
  if (!description) return null;
  return (
    <p className={cn('text-ui leading-tight text-muted-foreground', className)}>{description}</p>
  );
}

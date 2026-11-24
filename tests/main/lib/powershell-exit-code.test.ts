import { spawnSync } from 'child_process';

import { describe, expect, it } from 'vitest';

import {
  powerShellCommandArgs,
  powerShellCommandWithExitCode,
} from '../../../src/main/lib/powershell-native-arguments';

// A real PowerShell: CI's Windows runners have Windows PowerShell 5.1 and pwsh, and its Linux and
// macOS runners have pwsh. The exit code a command ends with is PowerShell's to decide, so only
// running one shows it, each of them where there are both.
const powerShells = ['pwsh', 'powershell'].filter(
  (shell) =>
    spawnSync(shell, ['-NoProfile', '-Command', 'exit 0'], { timeout: 30_000 }).status === 0
);

function exitCodeOf(powerShell: string, command: string): number | null {
  const args = powerShellCommandArgs(
    powerShell,
    ['-NoProfile', '-NonInteractive'],
    powerShellCommandWithExitCode(command)
  );
  return spawnSync(powerShell, args!, { encoding: 'utf8', timeout: 30_000 }).status;
}

// A native program, which sets $LASTEXITCODE as a cmdlet doesn't.
const node = (exitCode: number) => `& '${process.execPath}' -e 'process.exit(${exitCode})'`;

// Skipped on a computer without PowerShell, as a dev machine may be.
describe.runIf(powerShells.length > 0)('PowerShell exit codes', () => {
  describe.each(powerShells)(
    'a command run in %s until it exits',
    (powerShell) => {
      it('exits 0 when the command succeeds', () => {
        expect(exitCodeOf(powerShell, `${node(0)}; Write-Output done`)).toBe(0);
      });

      it("exits with a failed native program's exit code", () => {
        expect(exitCodeOf(powerShell, node(3))).toBe(3);
      });

      it('exits 1 when a cmdlet fails', () => {
        expect(exitCodeOf(powerShell, "Copy-Item -n 'missing-a' 'missing-b'")).toBe(1);
      });

      it('exits 1 when a cmdlet fails after a native program succeeded', () => {
        // As in `git fetch; cp -n .env.example .env`, where cp is Copy-Item, which has no -n.
        expect(exitCodeOf(powerShell, `${node(0)}; Copy-Item -n 'missing-a' 'missing-b'`)).toBe(1);
      });
    },
    60_000
  );
});

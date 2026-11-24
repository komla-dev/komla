import { execFileSync } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { load } from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';

import {
  TARGETS,
  installSpecs,
  platformPackages,
} from '../../../scripts/native-platform-packages.cjs';

const ROOT = join(__dirname, '..', '..', '..');

async function lockedVersion(name: string): Promise<string> {
  const lockfile = JSON.parse(await readFile(join(ROOT, 'package-lock.json'), 'utf8'));
  return lockfile.packages[`node_modules/${name}`].version;
}

describe('native platform packages', () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('installs the Windows sherpa-onnx build at the version the lockfile resolves', async () => {
    const specs = installSpecs(['win32-x64', 'win32-arm64']);

    expect(specs).toContain(`sherpa-onnx-win-x64@${await lockedVersion('sherpa-onnx-win-x64')}`);
    expect(specs).toContain(
      `@parcel/watcher-win32-arm64@${await lockedVersion('@parcel/watcher-win32-arm64')}`
    );
    expect(specs).toContain(
      `@vscode/ripgrep-win32-arm64@${await lockedVersion('@vscode/ripgrep-win32-arm64')}`
    );
  });

  it('installs the Intel macOS sherpa-onnx build alongside the Apple Silicon one', () => {
    const names = installSpecs(['darwin-arm64', 'darwin-x64']).map((spec) =>
      spec.replace(/@[^@]+$/, '')
    );

    expect(names).toEqual(
      expect.arrayContaining(['sherpa-onnx-darwin-arm64', 'sherpa-onnx-darwin-x64'])
    );
  });

  it('covers every target electron-builder.yml packages', async () => {
    const config = load(await readFile(join(ROOT, 'electron-builder.yml'), 'utf8')) as Record<
      string,
      { target: { arch: string[] }[] }
    >;
    const packaged = Object.entries({ mac: 'darwin', win: 'win32', linux: 'linux' }).flatMap(
      ([key, platform]) =>
        config[key].target.flatMap(({ arch }) => arch.map((a) => `${platform}-${a}`))
    );

    expect([...new Set(packaged)].sort()).toEqual([...TARGETS].sort());
  });

  it('names only packages the lockfile resolves, for every target', () => {
    expect(() => installSpecs(TARGETS)).not.toThrow();
  });

  it('ships the same sherpa-onnx build on every platform', async () => {
    const sherpa = TARGETS.flatMap((target) => {
      const [platform, arch] = target.split('-');
      return platformPackages(platform, arch).filter(({ name }) => name.startsWith('sherpa-onnx-'));
    });
    const versions = new Set(await Promise.all(sherpa.map(({ name }) => lockedVersion(name))));

    expect(sherpa).toHaveLength(5);
    expect(versions.size).toBe(1);
  });

  it('expects no sherpa-onnx build for Windows arm64, which sherpa-onnx does not publish', () => {
    expect(platformPackages('win32', 'arm64').map(({ name }) => name)).toEqual([
      '@vscode/ripgrep-win32-arm64',
      '@parcel/watcher-win32-arm64',
    ]);
  });

  it('rejects a package the lockfile does not resolve', async () => {
    dir = await mkdtemp(join(tmpdir(), 'komla-native-packages-'));
    const lockfile = join(dir, 'package-lock.json');
    await writeFile(lockfile, JSON.stringify({ packages: {} }));

    expect(() => installSpecs(['win32-x64'], lockfile)).toThrow(
      /ripgrep-win32-x64 is not in package-lock.json/
    );
  });

  it('rejects a target Komla does not build', () => {
    expect(() => platformPackages('freebsd', 'x64')).toThrow(/unsupported target freebsd-x64/);
    expect(() => installSpecs(['win32'])).toThrow(/unsupported target/);
  });

  it('prints one install spec per line from the command line', () => {
    const output = execFileSync(
      process.execPath,
      [join(ROOT, 'scripts', 'native-platform-packages.cjs'), 'win32-x64'],
      { encoding: 'utf8' }
    );

    expect(output.trim().split('\n')).toEqual(installSpecs(['win32-x64']));
  });
});

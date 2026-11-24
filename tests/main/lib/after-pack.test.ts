import { access, mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import afterPack from '../../../scripts/afterPack.cjs';

// electron-builder's Arch enum.
const X64 = 1;
const ARM64 = 3;
const ARCHES = { x64: X64, arm64: ARM64 } as const;
type ArchName = keyof typeof ARCHES;

const RESOURCES: Record<string, string> = {
  darwin: 'Komla.app/Contents/Resources',
  win32: 'resources',
  linux: 'resources',
};

/** The binaries a packaged app needs from each per-platform package, as the packages lay them out. */
function platformBinaries(platform: string, arch: ArchName): Record<string, string> {
  const exe = platform === 'win32' ? '.exe' : '';
  const watcherLibc = platform === 'linux' ? '-glibc' : '';
  const sherpaPlatform = platform === 'win32' ? 'win' : platform;
  const binaries: Record<string, string> = {
    [`@vscode/ripgrep-${platform}-${arch}`]: `bin/rg${exe}`,
    [`@parcel/watcher-${platform}-${arch}${watcherLibc}`]: 'watcher.node',
    [`sherpa-onnx-${sherpaPlatform}-${arch}`]: 'sherpa-onnx.node',
  };
  // sherpa-onnx publishes no Windows arm64 build.
  if (platform === 'win32' && arch === 'arm64') delete binaries['sherpa-onnx-win-arm64'];
  return binaries;
}

describe('afterPack per-platform native package check', () => {
  let appOutDir: string;

  beforeEach(async () => {
    appOutDir = await mkdtemp(join(tmpdir(), 'komla-after-pack-'));
    // release.sh exports this, and it makes the hook swap in a cached native module.
    vi.stubEnv('NATIVE_MODULES_CACHE', '');
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(appOutDir, { recursive: true, force: true });
  });

  function pack(electronPlatformName: string, arch: ArchName) {
    return afterPack({
      appOutDir,
      arch: ARCHES[arch],
      electronPlatformName,
      packager: { appInfo: { productFilename: 'Komla' } },
    });
  }

  async function ship(platform: string, packageName: string, binary: string) {
    const file = join(
      appOutDir,
      RESOURCES[platform],
      'app.asar.unpacked/node_modules',
      packageName,
      binary
    );
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, '');
  }

  async function shipAllExcept(platform: string, arch: ArchName, missing?: string) {
    for (const [name, binary] of Object.entries(platformBinaries(platform, arch))) {
      if (name !== missing) await ship(platform, name, binary);
    }
  }

  const TARGETS: [string, ArchName][] = [
    ['darwin', 'x64'],
    ['darwin', 'arm64'],
    ['win32', 'x64'],
    ['win32', 'arm64'],
    ['linux', 'x64'],
    ['linux', 'arm64'],
  ];

  it.each(TARGETS)(
    'accepts a %s %s app that ships its platform packages',
    async (platform, arch) => {
      await shipAllExcept(platform, arch);

      await expect(pack(platform, arch)).resolves.toBeUndefined();
    }
  );

  it.each(
    TARGETS.flatMap(([platform, arch]) =>
      Object.keys(platformBinaries(platform, arch)).map((name) => [platform, arch, name])
    )
  )('rejects a %s %s app without %s', async (platform, arch, name) => {
    await shipAllExcept(platform, arch as ArchName, name);

    await expect(pack(platform, arch as ArchName)).rejects.toThrow(name);
  });

  it('rejects a Windows x64 app that only ships the macOS sherpa-onnx build', async () => {
    await shipAllExcept('win32', 'x64', 'sherpa-onnx-win-x64');
    await ship('win32', 'sherpa-onnx-darwin-arm64', 'sherpa-onnx.node');

    await expect(pack('win32', 'x64')).rejects.toThrow(/sherpa-onnx-win-x64/);
  });

  it('rejects an Intel macOS app that only ships the Apple Silicon ripgrep', async () => {
    await shipAllExcept('darwin', 'x64', '@vscode/ripgrep-darwin-x64');
    await ship('darwin', '@vscode/ripgrep-darwin-arm64', 'bin/rg');

    await expect(pack('darwin', 'x64')).rejects.toThrow(/ripgrep-darwin-x64/);
  });

  it('says how to install the missing packages', async () => {
    await expect(pack('win32', 'x64')).rejects.toThrow(
      'npm install --no-save --force $(node scripts/native-platform-packages.cjs win32-x64)'
    );
  });

  it('names every missing package at once', async () => {
    await expect(pack('win32', 'x64')).rejects.toThrow(
      /ripgrep-win32-x64[\s\S]*watcher-win32-x64[\s\S]*sherpa-onnx-win-x64/
    );
  });

  async function shipped(platform: string, packageName: string) {
    const dir = join(appOutDir, RESOURCES[platform], 'app.asar.unpacked/node_modules', packageName);
    return access(dir).then(
      () => true,
      () => false
    );
  }

  it.each(TARGETS)(
    "removes the other targets' platform packages from a %s %s app",
    async (platform, arch) => {
      const own = platformBinaries(platform, arch);
      for (const [otherPlatform, otherArch] of TARGETS) {
        for (const [name, binary] of Object.entries(platformBinaries(otherPlatform, otherArch))) {
          await ship(platform, name, binary);
        }
      }
      await ship(platform, 'sherpa-onnx-node', 'sherpa-onnx.js');
      // Variants of the same packages that no Komla target uses.
      const unused = [
        '@parcel/watcher-linux-x64-musl',
        '@vscode/ripgrep-linux-ia32',
        'sherpa-onnx-win-ia32',
      ];
      for (const name of unused) await ship(platform, name, 'binary');
      await ship(platform, '@parcel/watcher', 'index.js');

      await pack(platform, arch);

      for (const [otherPlatform, otherArch] of TARGETS) {
        for (const name of Object.keys(platformBinaries(otherPlatform, otherArch))) {
          expect(await shipped(platform, name), name).toBe(name in own);
        }
      }
      expect(await shipped(platform, 'sherpa-onnx-node')).toBe(true);
      expect(await shipped(platform, '@parcel/watcher')).toBe(true);
      for (const name of unused) expect(await shipped(platform, name), name).toBe(false);
    }
  );
});

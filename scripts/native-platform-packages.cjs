/**
 * The per-platform npm packages that carry the binaries of Komla's native
 * modules (ripgrep, @parcel/watcher, sherpa-onnx). npm installs only the build
 * host's variant, and electron-builder ships only what is on disk, so a build
 * for another platform or arch has to install its variants first
 * (build-windows.sh and release.sh do), and afterPack checks each packaged app
 * against this list.
 *
 * node-pty and keyboard-layout are not here: node-pty ships every platform's
 * prebuild in its own package, and keyboard-layout is rebuilt per arch.
 *
 * CLI: node scripts/native-platform-packages.cjs <platform-arch>...
 *   prints `name@version` for each target's packages, one per line, at the
 *   version package-lock.json resolves, e.g. win32-x64 win32-arm64.
 */

const fs = require('fs');
const path = require('path');

/** Every platform-arch Komla packages an app for. */
const TARGETS = [
  'darwin-x64',
  'darwin-arm64',
  'win32-x64',
  'win32-arm64',
  'linux-x64',
  'linux-arm64',
];

/**
 * @param {string} platform Node's platform name: darwin, win32 or linux.
 * @param {string} arch x64 or arm64.
 * @returns {{ name: string, binary: string }[]} each package and the file in it the app loads.
 */
function platformPackages(platform, arch) {
  if (!['darwin', 'win32', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch)) {
    throw new Error(`native-platform-packages: unsupported target ${platform}-${arch}`);
  }
  const packages = [
    {
      name: `@vscode/ripgrep-${platform}-${arch}`,
      binary: platform === 'win32' ? 'bin/rg.exe' : 'bin/rg',
    },
    // Komla's Linux builds target glibc.
    {
      name: `@parcel/watcher-${platform}-${arch}${platform === 'linux' ? '-glibc' : ''}`,
      binary: 'watcher.node',
    },
  ];
  // sherpa-onnx publishes no Windows arm64 build, so voice transcription has no
  // native module there.
  if (!(platform === 'win32' && arch === 'arm64')) {
    // sherpa-onnx names its Windows packages "win", not "win32".
    const sherpaPlatform = platform === 'win32' ? 'win' : platform;
    packages.push({ name: `sherpa-onnx-${sherpaPlatform}-${arch}`, binary: 'sherpa-onnx.node' });
  }
  return packages;
}

/**
 * Whether a package is a per-platform variant of one of these native modules,
 * for any platform, including ones no Komla target uses (musl, ia32).
 */
function isPlatformPackage(name) {
  return /^(@vscode\/ripgrep-|@parcel\/watcher-|sherpa-onnx-(?!node$))/.test(name);
}

/** `name@version` for each target's packages, at the versions package-lock.json resolves. */
function installSpecs(targets, lockfilePath = path.join(__dirname, '..', 'package-lock.json')) {
  const locked = JSON.parse(fs.readFileSync(lockfilePath, 'utf8')).packages;
  const specs = new Set();
  for (const target of targets) {
    const [platform, arch] = target.split('-');
    for (const { name } of platformPackages(platform, arch)) {
      const version = locked[`node_modules/${name}`]?.version;
      if (!version)
        throw new Error(`native-platform-packages: ${name} is not in package-lock.json`);
      specs.add(`${name}@${version}`);
    }
  }
  return [...specs];
}

module.exports = { TARGETS, platformPackages, isPlatformPackage, installSpecs };

if (require.main === module) {
  try {
    const targets = process.argv.slice(2);
    if (targets.length === 0)
      throw new Error('usage: native-platform-packages.cjs <platform-arch>...');
    console.log(installSpecs(targets).join('\n'));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

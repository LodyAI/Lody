// Builds the Node-API module for the current host (or LODY_IROH_TARGET) and copies
// it to `lody-iroh.<platform>-<arch>.node` beside index.js, where the loader looks.
//   node packages/iroh-native/scripts/build.mjs [--debug]
// Requires a Rust toolchain at the workspace rust-version.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeFileName } from '../index.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const debug = process.argv.includes('--debug');
const target = process.env.LODY_IROH_TARGET;
const args = ['build', '--locked', '-p', 'lody-iroh-napi'];
if (!debug) args.push('--release');
if (target) args.push('--target', target);
execFileSync('cargo', args, { cwd: root, stdio: 'inherit' });

const targetDir = process.env.CARGO_TARGET_DIR ?? path.join(root, 'target');
const profileDir = path.join(targetDir, target ?? '', debug ? 'debug' : 'release');
const platform = process.env.LODY_IROH_PLATFORM ?? process.platform;
const arch = process.env.LODY_IROH_ARCH ?? process.arch;
const library =
  platform === 'win32'
    ? 'lody_iroh_napi.dll'
    : platform === 'darwin'
      ? 'liblody_iroh_napi.dylib'
      : 'liblody_iroh_napi.so';
const built = path.join(profileDir, library);
if (!existsSync(built)) throw new Error(`missing build output ${built}`);
const output = path.join(root, nativeFileName(platform, arch));
copyFileSync(built, output);
console.log(`wrote ${path.relative(process.cwd(), output)}`);

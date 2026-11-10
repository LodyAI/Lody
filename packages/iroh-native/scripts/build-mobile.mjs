// Builds the UniFFI mobile binding of lody-iroh and its generated Swift/Kotlin
// sources for the native shells:
//   node packages/iroh-native/scripts/build-mobile.mjs ios      # macOS + Xcode
//   node packages/iroh-native/scripts/build-mobile.mjs android  # cargo-ndk + Android NDK
// Output: packages/iroh-native/mobile-dist/{ios,android}. Requires the Rust targets
// (`rustup target add aarch64-apple-ios aarch64-apple-ios-sim` or
// `aarch64-linux-android x86_64-linux-android`).
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const targetDir = process.env.CARGO_TARGET_DIR ?? path.join(root, 'target');
const out = path.join(root, 'mobile-dist');
const run = (command, args, env = {}) =>
  execFileSync(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });
const bindgen = (library, language, dir) =>
  run('cargo', [
    'run',
    '--locked',
    '--release',
    '-p',
    'lody-iroh-uniffi',
    '--bin',
    'uniffi-bindgen',
    '--',
    'generate',
    '--library',
    library,
    '--language',
    language,
    '--out-dir',
    dir,
    '--no-format',
  ]);

const platform = process.argv[2];
if (platform === 'ios') {
  const targets = ['aarch64-apple-ios', 'aarch64-apple-ios-sim'];
  for (const target of targets)
    run('cargo', ['build', '--locked', '--release', '-p', 'lody-iroh-uniffi', '--target', target], {
      IPHONEOS_DEPLOYMENT_TARGET: '16.4',
    });
  const dir = path.join(out, 'ios');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.join(dir, 'headers'), { recursive: true });
  const lib = (target) => path.join(targetDir, target, 'release', 'liblody_iroh_uniffi.a');
  bindgen(lib(targets[0]), 'swift', path.join(dir, 'swift'));
  run('cp', [path.join(dir, 'swift', 'lody_iroh_uniffiFFI.h'), path.join(dir, 'headers')]);
  run('cp', [
    path.join(dir, 'swift', 'lody_iroh_uniffiFFI.modulemap'),
    path.join(dir, 'headers', 'module.modulemap'),
  ]);
  run('xcodebuild', [
    '-create-xcframework',
    ...targets.flatMap((target) => [
      '-library',
      lib(target),
      '-headers',
      path.join(dir, 'headers'),
    ]),
    '-output',
    path.join(dir, 'LodyIroh.xcframework'),
  ]);
  console.log(`wrote ${path.relative(process.cwd(), dir)}`);
} else if (platform === 'android') {
  const dir = path.join(out, 'android');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  run('cargo', [
    'ndk',
    '-t',
    'arm64-v8a',
    '-t',
    'x86_64',
    '-P',
    '26',
    '-o',
    path.join(dir, 'jniLibs'),
    'build',
    '--locked',
    '--release',
    '-p',
    'lody-iroh-uniffi',
  ]);
  const library = path.join(dir, 'jniLibs', 'arm64-v8a', 'liblody_iroh_uniffi.so');
  if (!existsSync(library)) throw new Error(`missing ${library}`);
  bindgen(library, 'kotlin', path.join(dir, 'kotlin'));
  console.log(`wrote ${path.relative(process.cwd(), dir)}`);
} else {
  throw new Error('usage: build-mobile.mjs ios|android');
}

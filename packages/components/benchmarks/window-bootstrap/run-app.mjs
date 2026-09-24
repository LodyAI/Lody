import { build } from 'vite';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { cpus, homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../..', import.meta.url));
const appPath = resolve(root, '../../apps/electron');
const require = createRequire(join(appPath, 'package.json'));
const electron = require('electron').trim();
const repeats = Number(process.argv[2] ?? 10);
const rounds = Number(process.argv[4] ?? 1500);
const preparedMode = process.env.PROBE_PREPARED === '1';
const nativeMode = process.env.PROBE_MAC_NATIVE === '1';
if ((preparedMode || nativeMode) && process.platform !== 'darwin')
  throw new Error('Prepared-surface/native prototype is macOS-only');
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10000)
  throw new Error('Rounds must be between 1 and 10000');
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 100)
  throw new Error('Repeats must be between 1 and 100');
await readFile(join(appPath, 'out/main/index.js'));
const cliEntry = join(appPath, 'resources/cli/index.js');
const cliHash = createHash('sha256')
  .update(await readFile(cliEntry))
  .digest('hex');
// macOS Unix sockets require a short data-directory path.
const artifacts = await mkdtemp('/tmp/lody-app-bench-');
const profile = join(artifacts, 'profile');
await mkdir(profile);
await mkdir(join(artifacts, 'data'));
await writeFile(join(profile, 'onboarding-state.json'), '{"completed":true}');
const cache = join(root, 'node_modules/.cache');
await mkdir(cache, { recursive: true });
const buildDir = await mkdtemp(join(cache, 'app-bench-'));
try {
  let nativeAddon;
  if (nativeMode) {
    const version = require('electron/package.json').version;
    const headers =
      process.env.PROBE_NODE_HEADERS ??
      join(homedir(), 'Library/Caches/node-gyp', version, 'include/node');
    await readFile(join(headers, 'node_api.h'));
    nativeAddon = join(buildDir, 'macos-window-host.node');
    execFileSync(
      'xcrun',
      [
        'clang++',
        '-std=c++17',
        '-bundle',
        '-undefined',
        'dynamic_lookup',
        '-fobjc-arc',
        '-framework',
        'AppKit',
        '-I',
        headers,
        fileURLToPath(new URL('./macos-window-host.mm', import.meta.url)),
        '-o',
        nativeAddon,
      ],
      { stdio: 'inherit' }
    );
  }
  await build({
    configFile: false,
    root,
    logLevel: 'error',
    build: {
      target: 'esnext',
      minify: false,
      outDir: buildDir,
      emptyOutDir: false,
      lib: {
        entry: join(root, 'tests/conversation-view-fixtures.ts'),
        formats: ['cjs'],
        fileName: () => 'fixture.cjs',
      },
      rollupOptions: { external: ['loro-crdt', 'loro-mirror', '@loro-dev/flock-wasm'] },
    },
  });
  const fixture = createRequire(join(root, 'package.json'))(join(buildDir, 'fixture.cjs'));
  const binary = fixture
    .buildSessionDoc(fixture.buildFixtureHistory(rounds))
    .export({ mode: 'snapshot' });
  const fixturePath = join(artifacts, 'fixture.b64');
  await writeFile(fixturePath, Buffer.from(binary).toString('base64'));
  const env = {
    ...process.env,
    LODY_DATA_DIR: join(artifacts, 'data'),
    LODY_LOCKS_DIR: join(artifacts, 'locks'),
    LODY_ELECTRON_USER_DATA_DIR: profile,
    LODY_ELECTRON_USE_BUNDLED_CLI: '1',
    PROBE_APP_PATH: appPath,
    PROBE_ENTRY: join(appPath, 'out/main/index.js'),
    PROBE_OUTPUT: join(artifacts, 'result'),
    PROBE_FIXTURE: fixturePath,
    PROBE_VARIANT: process.argv[3] ?? 'current',
    PROBE_REPEATS: String(repeats),
    PROBE_ROUNDS: String(rounds),
    ...(nativeAddon ? { PROBE_NATIVE_ADDON: nativeAddon } : {}),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.LODY_E2E;
  delete env.LODY_DISABLE_WINDOW_WARMUP;
  const metadata = {
    cpu: cpus()[0]?.model,
    preparedMode,
    nativeMode,
    platform: process.platform,
    arch: process.arch,
    cliEntrySha256: cliHash,
    runtimeProviderSha256: createHash('sha256')
      .update(await readFile(join(root, 'src/providers/runtime-provider.tsx')))
      .digest('hex'),
    rendererIndexSha256: createHash('sha256')
      .update(await readFile(join(appPath, 'out/renderer/index.html')))
      .digest('hex'),
  };
  await writeFile(join(artifacts, 'environment.json'), JSON.stringify(metadata, null, 2));
  const entry = fileURLToPath(new URL('./real-app-probe.cjs', import.meta.url));
  const exitCode = await new Promise((resolveExit, reject) => {
    const child = spawn(electron, [entry], { env, stdio: 'inherit', cwd: appPath });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveExit(signal ?? code));
  });
  console.log(`Artifacts: ${artifacts}`);
  if (exitCode !== 0)
    throw new Error(`Application probe exited ${exitCode}; inspect retained logs/artifacts`);
  const failure = await readFile(join(artifacts, 'result.failure.json'), 'utf8').catch(() => null);
  if (failure) throw new Error('Application probe failed: ' + JSON.parse(failure).error);
  const result = JSON.parse(await readFile(join(artifacts, 'result.json'), 'utf8'));
  if (result.results.length !== repeats + 3) throw new Error('Incomplete application probe');
} finally {
  await rm(buildDir, { recursive: true, force: true });
}

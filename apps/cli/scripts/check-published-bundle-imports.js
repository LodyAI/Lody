#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { collectRuntimeDependencyVersionIssues } from './published-runtime-dependency-policy.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliRoot = path.resolve(__dirname, '..');
const distDir = path.join(cliRoot, 'dist');
const packageJsonPath = path.join(cliRoot, 'package.json');

const dependencyBlocks = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const workspacePackageNames = new Set();
const requiredPublishedRuntimeDependencies = [
  'better-sqlite3',
  'loro-crdt',
  '@lydell/node-pty',
  // Kept external from the bundle (resolves its own entry/worker.js relative to its
  // package dir); the diff line-count worker pool requires it at runtime.
  'tinypool',
  // Kept external because it `require.resolve`s its binary from a sibling
  // per-platform package; the local-project file listing spawns that binary.
  '@vscode/ripgrep',
];
// @lydell/node-pty pins its per-platform binary packages to its own exact version, and
// the Electron staging in apps/electron/scripts/cli-native-deps.mjs mirrors that package
// layout — which changed shape between 1.1.0 and 1.2.0. A range here would let a publish
// resolve a layout the packaging never saw. Do NOT drop to @lydell/node-pty@1.1.0: it
// repackages node-pty 1.1.0-beta14, which predates the queued pty writer and writes
// through tty.WriteStream, where EAGAIN is masked and can block (microsoft/node-pty#833).
const requiredExactPublishedRuntimeDependencies = ['loro-crdt'];
const requiredPinnedPublishedRuntimeDependencies = new Map([['@lydell/node-pty', '1.2.0-beta.14']]);

for (const block of dependencyBlocks) {
  const dependencies = packageJson[block];
  if (!dependencies || typeof dependencies !== 'object') {
    continue;
  }

  for (const [name, version] of Object.entries(dependencies)) {
    if (typeof version === 'string' && version.startsWith('workspace:')) {
      workspacePackageNames.add(name);
    }
  }
}

if (workspacePackageNames.size === 0) {
  console.log('No workspace dependencies found in CLI package.json.');
  process.exit(0);
}

if (!fs.existsSync(distDir)) {
  console.error(`Cannot check published bundle imports because ${distDir} does not exist.`);
  process.exit(1);
}

const jsFiles = listJsFiles(distDir);
if (jsFiles.length === 0) {
  console.error(`Cannot check published bundle imports because ${distDir} has no .js files.`);
  process.exit(1);
}

const violations = [];

for (const filePath of jsFiles) {
  const source = fs.readFileSync(filePath, 'utf8');
  const packageVariables = collectWorkspacePackageVariables(source);

  scanLiteralImports(filePath, source, violations);
  scanVariableImports(filePath, source, packageVariables, violations);
}

if (violations.length > 0) {
  console.error('Published CLI bundle still imports workspace packages at runtime:');
  for (const violation of violations) {
    console.error(
      `  - ${path.relative(cliRoot, violation.filePath)}:${violation.line}:${violation.column} ` +
        `${violation.kind} ${violation.specifier}`
    );
  }
  console.error(
    '\nBundle these packages before publishing, or move them to real runtime dependencies.'
  );
  process.exit(1);
}

checkPublishedRuntimeDependencies();
runDeepSeekAdapterBundleSmoke();
runGrokAdapterBundleSmoke();
runPublishedRuntimeSmoke();
runWorkspaceWatchWorkerSmoke();
runDiffWorkerSmoke();
runTurnDiffStoreWorkerSmoke();

console.log('Published CLI bundle import check passed.');

function listJsFiles(rootDir) {
  const results = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) {
      continue;
    }

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        results.push(fullPath);
      }
    }
  }

  return results.sort();
}

function collectWorkspacePackageVariables(source) {
  const packageVariables = new Map();
  const constStringPattern = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(['"])([^'"]+)\2\s*;/g;

  for (const match of source.matchAll(constStringPattern)) {
    const variableName = match[1];
    const specifier = match[3];
    if (variableName && specifier && isWorkspaceSpecifier(specifier)) {
      packageVariables.set(variableName, specifier);
    }
  }

  return packageVariables;
}

function scanLiteralImports(filePath, source, output) {
  const patterns = [
    { kind: 'static import/export', pattern: /\b(?:from|import)\s*(['"])([^'"]+)\1/g },
    { kind: 'dynamic import', pattern: /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g },
    { kind: 'require', pattern: /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g },
  ];

  for (const { kind, pattern } of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[2];
      if (!specifier || !isWorkspaceSpecifier(specifier)) {
        continue;
      }

      output.push({
        filePath,
        kind,
        specifier,
        ...lineColumn(source, match.index ?? 0),
      });
    }
  }
}

function scanVariableImports(filePath, source, packageVariables, output) {
  for (const [variableName, specifier] of packageVariables) {
    const escapedName = escapeRegExp(variableName);
    const patterns = [
      {
        kind: 'dynamic import via variable',
        pattern: new RegExp(`\\bimport\\s*\\(\\s*${escapedName}\\s*\\)`, 'g'),
      },
      {
        kind: 'require via variable',
        pattern: new RegExp(`\\brequire\\s*\\(\\s*${escapedName}\\s*\\)`, 'g'),
      },
    ];

    for (const { kind, pattern } of patterns) {
      for (const match of source.matchAll(pattern)) {
        output.push({
          filePath,
          kind,
          specifier,
          ...lineColumn(source, match.index ?? 0),
        });
      }
    }
  }
}

function isWorkspaceSpecifier(specifier) {
  for (const workspacePackageName of workspacePackageNames) {
    if (specifier === workspacePackageName || specifier.startsWith(`${workspacePackageName}/`)) {
      return true;
    }
  }

  return false;
}

function lineColumn(source, index) {
  let line = 1;
  let column = 1;

  for (let i = 0; i < index; i += 1) {
    if (source.charCodeAt(i) === 10) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }

  return { line, column };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function checkPublishedRuntimeDependencies() {
  const publishedDependencyBlocks = [
    packageJson.dependencies,
    packageJson.optionalDependencies,
    packageJson.peerDependencies,
  ];
  const missing = requiredPublishedRuntimeDependencies.filter(
    (dependencyName) => !publishedDependencyBlocks.some((deps) => deps?.[dependencyName])
  );

  if (missing.length === 0) {
    checkExactPublishedRuntimeDependencies(publishedDependencyBlocks);
    return;
  }

  console.error('Published CLI package is missing runtime dependencies required by the bundle:');
  for (const dependencyName of missing) {
    console.error(`  - ${dependencyName}`);
  }
  console.error(
    '\nMove these packages to dependencies, optionalDependencies, or peerDependencies.'
  );
  process.exit(1);
}

function checkExactPublishedRuntimeDependencies(publishedDependencyBlocks) {
  const mismatched = collectRuntimeDependencyVersionIssues({
    dependencyBlocks: publishedDependencyBlocks,
    exactDependencies: requiredExactPublishedRuntimeDependencies,
    pinnedDependencies: requiredPinnedPublishedRuntimeDependencies,
  });

  if (mismatched.length === 0) {
    return;
  }

  console.error('Published CLI package has runtime dependencies with unsafe versions:');
  for (const { dependencyName, expectedVersion, actualVersion } of mismatched) {
    console.error(
      `  - ${dependencyName}: expected ${expectedVersion}, got ${actualVersion ?? 'missing'}`
    );
  }
  console.error(
    '\nUse exact versions so the published CLI resolves the same dependency build that was tested.'
  );
  process.exit(1);
}

function runDeepSeekAdapterBundleSmoke() {
  const adapterPath = path.join(distDir, 'deepseek-acp.js');
  if (!fs.existsSync(adapterPath)) {
    console.error(`Published CLI DeepSeek adapter is missing: ${adapterPath}`);
    process.exit(1);
  }

  for (const presetId of ['standard', 'code', 'minimal', 'cordis']) {
    const presetPath = path.join(distDir, 'deepseek-agent-presets', presetId, 'agent.cordis.yml');
    if (!fs.existsSync(presetPath)) {
      console.error(`Published CLI DeepSeek preset is missing: ${presetPath}`);
      process.exit(1);
    }
  }

  const smokeScript = `
const adapter = await import(${JSON.stringify(pathToFileURL(adapterPath).href)});
if (adapter.name !== 'acp-extension-dsh') process.exit(2);
if (typeof adapter.apply !== 'function') process.exit(3);
if (!Array.isArray(adapter.inject) || !adapter.inject.includes('permissionPresets')) process.exit(4);
`;
  try {
    execFileSync(process.execPath, ['--input-type=module', '--eval', smokeScript], {
      cwd: cliRoot,
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch (error) {
    console.error('Published CLI DeepSeek adapter bundle smoke failed.');
    if (error && typeof error === 'object') {
      if ('stdout' in error && error.stdout) console.error(String(error.stdout));
      if ('stderr' in error && error.stderr) console.error(String(error.stderr));
    }
    process.exit(1);
  }
}

function runGrokAdapterBundleSmoke() {
  const adapterPath = path.join(distDir, 'grok-acp.js');
  if (!fs.existsSync(adapterPath)) {
    console.error(`Published CLI Grok adapter is missing: ${adapterPath}`);
    process.exit(1);
  }

  const env = { ...process.env };
  delete env.GROK_PATH;
  const result = spawnSync(process.execPath, [adapterPath], {
    cwd: cliRoot,
    encoding: 'utf8',
    env,
    input: '',
  });
  const expectedError = 'GROK_PATH must point to the official Grok runtime';
  if (result.status === 1 && result.stderr.includes(expectedError)) {
    return;
  }

  console.error('Published CLI Grok adapter bundle smoke failed.');
  if (result.error) console.error(result.error.message);
  if (result.stdout) console.error(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exit(1);
}

function runPublishedRuntimeSmoke() {
  const bundleUrl = pathToFileURL(path.join(distDir, 'index.js')).href;
  const smokeScript = `
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalExit = process.exit.bind(process);
process.stdout.write = () => true;
process.stderr.write = () => true;
process.argv = ['node', 'lody', '--version'];
process.exit = () => {};
await import(${JSON.stringify(bundleUrl)});
await new Promise((resolve) => setTimeout(resolve, 100));
const { createRequire } = await import('node:module');
const requireFromBundle = createRequire(new URL(${JSON.stringify(bundleUrl)}));
// better-sqlite3 dlopens its binding lazily inside the Database constructor, so a
// bare require would pass even with the binding missing — which is exactly how an
// install-script-less environment breaks. Open a real database instead.
const Database = requireFromBundle('better-sqlite3');
const probeDb = new Database(':memory:');
probeDb.exec('CREATE TABLE t(a)');
probeDb.close();
requireFromBundle('@lydell/node-pty');
requireFromBundle.resolve('loro-crdt');
requireFromBundle.resolve('tinypool');
originalStdoutWrite('Published CLI runtime CJS dependency smoke passed.\\n');
originalExit(0);
`;

  try {
    execFileSync(process.execPath, ['--input-type=module', '--eval', smokeScript], {
      cwd: cliRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        SENTRY_TRACES_SAMPLE_RATE: '0.25',
        SENTRY_PROFILES_SAMPLE_RATE: '0.125',
      },
      stdio: 'pipe',
    });
  } catch (error) {
    console.error('Published CLI runtime CJS dependency smoke failed.');
    if (error && typeof error === 'object') {
      const output = error;
      if ('stdout' in output && output.stdout) {
        console.error(String(output.stdout));
      }
      if ('stderr' in output && output.stderr) {
        console.error(String(output.stderr));
      }
    }
    process.exit(1);
  }
}

function runWorkspaceWatchWorkerSmoke() {
  const workerPath = path.join(distDir, 'code-collab-watch-worker.js');
  if (!fs.existsSync(workerPath)) {
    console.error(`Published CLI watch worker is missing: ${workerPath}`);
    process.exit(1);
  }
  const smokeScript = `
const { spawn } = await import('node:child_process');
const { mkdtemp, rm } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const path = await import('node:path');
const root = await mkdtemp(path.join(tmpdir(), 'lody-watch-worker-smoke-'));
const child = spawn(process.execPath, [${JSON.stringify(workerPath)}], {
  env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG },
  stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
});
const timeout = setTimeout(() => { child.kill('SIGKILL'); process.exit(2); }, 5000);
child.on('message', (message) => {
  if (message?.type !== 'code-collab-watch/ready') return;
  if (message.generation !== 1 || message.revision !== 1 || message.watchedRoots.length !== 1) {
    process.exit(3);
  }
  child.send({ type: 'code-collab-watch/shutdown', generation: 1 });
});
child.on('exit', async (code) => {
  clearTimeout(timeout);
  await rm(root, { recursive: true, force: true });
  process.exit(code === 0 ? 0 : 4);
});
child.send({ type: 'code-collab-watch/replace-roots', generation: 1, revision: 1, roots: [root] });
`;
  try {
    execFileSync(process.execPath, ['--input-type=module', '--eval', smokeScript], {
      cwd: cliRoot,
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch (error) {
    console.error('Published CLI watch worker smoke failed.');
    if (error && typeof error === 'object' && 'stderr' in error && error.stderr) {
      console.error(String(error.stderr));
    }
    process.exit(1);
  }
}

function runTurnDiffStoreWorkerSmoke() {
  const workerPath = path.join(distDir, 'turn-diff-store-worker.js');
  if (!fs.existsSync(workerPath)) {
    console.error(`Published CLI turn-diff worker is missing: ${workerPath}`);
    process.exit(1);
  }
  const smokeScript = `
const { Worker } = await import('node:worker_threads');
const { mkdtemp, rm } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const path = await import('node:path');
const root = await mkdtemp(path.join(tmpdir(), 'lody-turn-diff-worker-smoke-'));
const worker = new Worker(${JSON.stringify(workerPath)}, { execArgv: [] });
let nextId = 1;
const call = (body) => new Promise((resolve, reject) => {
  const id = nextId++;
  const onMessage = (message) => {
    if (message?.id !== id) return;
    worker.off('message', onMessage);
    if ('error' in message) reject(new Error(message.error));
    else resolve(message.result);
  };
  worker.on('message', onMessage);
  worker.postMessage({ id, ...body });
});
try {
  await call({ kind: 'init', options: { dbPath: path.join(root, 'turn-diffs.sqlite3') } });
  const headProof = await call({ kind: 'allocate-head-proof' });
  await call({
    kind: 'record',
    input: {
      ownerId: 'smoke-session',
      turnId: 'smoke-turn',
      capturedAtMs: 1000,
      recordedAtMs: 1000,
      events: [
        {
          path: 'smoke.txt',
          oldText: null,
          newText: 'worker bundle ok',
          newIsCurrent: true,
          headProof,
          add: 1,
          del: 0,
        },
      ],
    },
  });
  const snapshot = await call({
    kind: 'turn-snapshot',
    input: { ownerId: 'smoke-session', turnId: 'smoke-turn', path: 'smoke.txt', nowMs: 1000 },
  });
  const latest = await call({
    kind: 'latest-text',
    input: { ownerId: 'smoke-session', path: 'smoke.txt' },
  });
  const stats = await call({ kind: 'stats' });
  if (snapshot?.status !== 'ready' || snapshot.newText !== 'worker bundle ok') process.exit(2);
  if (latest?.status !== 'tracked' || latest.text !== 'worker bundle ok') process.exit(4);
  if (stats?.integrity !== 'ok' || stats.invalidSnapshotRefCounts !== 0 || stats.invalidChunkRefCounts !== 0) process.exit(3);
  await call({ kind: 'close' });
} finally {
  await worker.terminate();
  await rm(root, { recursive: true, force: true });
}
`;
  try {
    execFileSync(process.execPath, ['--input-type=module', '--eval', smokeScript], {
      cwd: cliRoot,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 10_000,
    });
  } catch (error) {
    console.error('Published CLI turn-diff worker smoke failed.');
    if (error && typeof error === 'object') {
      if ('stdout' in error && error.stdout) console.error(String(error.stdout));
      if ('stderr' in error && error.stderr) console.error(String(error.stderr));
    }
    process.exit(1);
  }
}

function runDiffWorkerSmoke() {
  const workerPath = path.join(distDir, 'diff-worker.js');
  if (!fs.existsSync(workerPath)) {
    console.error(`Published CLI diff worker is missing: ${workerPath}`);
    process.exit(1);
  }
  const smokeScript = `
const { default: Tinypool } = await import('tinypool');
const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const path = await import('node:path');
const root = await mkdtemp(path.join(tmpdir(), 'lody-diff-worker-smoke-'));
const filePath = path.join(root, 'smoke.txt');
const pool = new Tinypool({
  filename: ${JSON.stringify(workerPath)},
  minThreads: 1,
  maxThreads: 1,
  execArgv: [],
});
try {
  await writeFile(filePath, 'worker proof ok\\n');
  const result = await pool.run({
    kind: 'turn-evidence',
    oldText: 'old\\n',
    newText: 'worker proof ok\\n',
    absolutePath: filePath,
  });
  if (result?.kind !== 'turn-evidence' || result.newIsCurrent !== true) process.exit(2);
  if (!Array.isArray(result.lineCounts) || result.lineCounts.length !== 2) process.exit(3);
} finally {
  await pool.destroy();
  await rm(root, { recursive: true, force: true });
}
`;
  try {
    execFileSync(process.execPath, ['--input-type=module', '--eval', smokeScript], {
      cwd: cliRoot,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 10_000,
    });
  } catch (error) {
    console.error('Published CLI diff worker smoke failed.');
    if (error && typeof error === 'object') {
      if ('stdout' in error && error.stdout) console.error(String(error.stdout));
      if ('stderr' in error && error.stderr) console.error(String(error.stderr));
    }
    process.exit(1);
  }
}

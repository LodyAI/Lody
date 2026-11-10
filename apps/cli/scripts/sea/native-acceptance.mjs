import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const execute = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
if (process.platform === 'win32')
  throw new Error('Windows managed update containment is not yet supported');
const scripts = path.join(repo, 'apps/cli/scripts/sea');
const root = await fsp.mkdtemp('/tmp/lody-sea-native-');
console.log(JSON.stringify({ fixture: root }));
const version = JSON.parse(await fsp.readFile(path.join(repo, 'apps/cli/package.json'))).version;
const platform = `${process.platform}-${process.arch}`;
const runtime = {};
const run = async (command, args, opts = {}) => {
  try {
    return await execute(command, args, {
      cwd: root,
      encoding: 'utf8',
      timeout: 240000,
      maxBuffer: 4 * 1024 * 1024,
      ...opts,
    });
  } catch (error) {
    throw new Error(
      `${path.basename(command)} ${args.join(' ')} failed: ${String(error.stderr ?? '').slice(-4000)} ${String(error.stdout ?? '').slice(-1000)}`,
      { cause: error }
    );
  }
};
const cfg = {
  staging: path.join(root, 'stage'),
  dist: path.join(repo, 'apps/cli/dist'),
  cliRoot: path.join(repo, 'apps/cli'),
  output: path.join(root, 'initial'),
  node: process.execPath,
  product: 'lody-oss',
  version,
  channel: 'stable',
  platform,
};
const save = async (name, value) => {
  const file = path.join(root, name);
  await fsp.writeFile(file, JSON.stringify(value));
  return file;
};
await run(process.execPath, [path.join(scripts, 'stage.mjs'), await save('stage.json', cfg)]);
async function build(name, staging, releaseVersion) {
  const output = path.join(root, name);
  await run(process.execPath, [
    path.join(scripts, 'build.mjs'),
    await save(name + '.json', { ...cfg, staging, version: releaseVersion, output }),
  ]);
  if (process.platform === 'darwin')
    await run('/usr/bin/codesign', ['--force', '--sign', '-', output]);
  const directory = path.join(root, name + '-release');
  await run(process.execPath, [
    path.join(scripts, 'finalize.mjs'),
    await save(name + '-final.json', {
      capsule: output,
      node: process.execPath,
      outputDir: directory,
      source: 'a'.repeat(40),
    }),
  ]);
  return { output, directory };
}
const initial = await build('initial', cfg.staging, version);
const stage2 = path.join(root, 'stage-updated');
await fsp.cp(cfg.staging, stage2, { recursive: true });
await fsp.writeFile(path.join(stage2, 'synthetic-build-marker'), 'updated payload');
const updated = await build('updated', stage2, version);
runtime[version] = updated.directory;
// A synthetic candidate fails after proving it owns no remaining descendants.
// This exercises the real watchdog rollback, without opening or changing user data.
const failedVersion = version.replace(
  /^(\d+\.\d+\.)(\d+)$/,
  (_all, prefix, patch) => prefix + (Number(patch) + 1)
);
const failingStage = path.join(root, 'stage-failing');
await fsp.cp(cfg.staging, failingStage, { recursive: true });
await fsp.writeFile(
  path.join(failingStage, 'index.js'),
  `if(process.argv.includes('--version')) console.log(${JSON.stringify(failedVersion)}); else if(process.send) process.send({type:'lody/managed-drained',instanceId:process.env.LODY_SUPERVISOR_INSTANCE_ID},()=>process.exit(1)); else process.exit(1);`
);
const failing = await build('failing', failingStage, failedVersion);
runtime[failedVersion] = failing.directory;
const server = http.createServer(async (req, res) => {
  try {
    const parts = new URL(req.url, 'http://localhost').pathname.split('/').filter(Boolean);
    if (
      parts.length !== 6 ||
      parts[0] !== 'api' ||
      parts[1] !== 'runtimes' ||
      parts[2] !== 'lody-oss-daemon' ||
      parts[4] !== platform ||
      !['manifest.json', 'daemon.gz', 'node.gz'].includes(parts[5]) ||
      !runtime[parts[3]]
    ) {
      res.writeHead(404);
      res.end();
      return;
    }
    const file = path.join(runtime[parts[3]], parts[5]);
    const bytes = await fsp.readFile(file);
    const range = req.headers.range;
    if (range) {
      const offset = Number(/^bytes=(\d+)-$/.exec(range)?.[1]);
      res.writeHead(206, {
        'Content-Range': `bytes ${offset}-${bytes.length - 1}/${bytes.length}`,
      });
      res.end(bytes.subarray(offset));
    } else {
      res.writeHead(200, {
        'Content-Length': bytes.length,
        'Content-Type': 'application/octet-stream',
      });
      res.end(bytes);
    }
  } catch (error) {
    res.writeHead(500);
    res.end(String(error));
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const portProbe = net.createServer();
await new Promise((resolve) => portProbe.listen(0, '127.0.0.1', resolve));
const port = portProbe.address().port;
await new Promise((resolve) => portProbe.close(resolve));
const data = path.join(root, 'data');
const env = {
  PATH: path.join(root, 'empty-path'),
  LANG: 'en_US.UTF-8',
  LODY_DATA_DIR: data,
  LODY_E2E: '1',
  LODY_E2E_LOCAL_CLI_HOST_PORT: String(port),
  LODY_RUNTIME_BASE_URL: `http://127.0.0.1:${address.port}`,
  LODY_LOG_MODE: 'file',
};
const command = async (args) => run(initial.output, args, { env });
let monitor,
  started = false;
function observeOperation(predicate) {
  const dir = path.join(data, 'daemon-managed');
  let watcher, timer;
  return new Promise((resolve, reject) => {
    let checking = false,
      again = false,
      done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      watcher?.close();
      clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    const check = async () => {
      if (checking) {
        again = true;
        return;
      }
      checking = true;
      do {
        again = false;
        try {
          const value = JSON.parse(await fsp.readFile(path.join(dir, 'operation.json'), 'utf8'));
          if (predicate(value)) finish(null, value);
        } catch (error) {
          if (error.code !== 'ENOENT') finish(error);
        }
      } while (again && !done);
      checking = false;
    };
    watcher = fs.watch(dir, (_event, name) => {
      if (name === 'operation.json') void check();
    });
    timer = setTimeout(() => finish(new Error('Operation observation timed out')), 180000);
    void check();
  });
}
try {
  await command(['daemon', 'install']); // Downloads pinned Node with no Node/npm on PATH.
  await command(['__sea-native-probe']);
  const launch = await command(['daemon', 'start', '--skip-auth-check']);
  started = true;
  await fsp.writeFile(path.join(root, 'launch.txt'), launch.stdout + '\n' + launch.stderr);
  const record = JSON.parse(await fsp.readFile(path.join(data, 'daemon.pid'), 'utf8'));
  let closed = false;
  monitor = net.createConnection({ host: '127.0.0.1', port });
  const inspected = await new Promise((resolve, reject) => {
    monitor.once('data', (buffer) => resolve(JSON.parse(buffer.toString().split('\n')[0])));
    monitor.once('error', reject);
  });
  monitor.once('close', () => {
    closed = true;
  });
  assert.equal(inspected.pid, record.pid);
  const applied = observeOperation((op) => op.phase === 'applied');
  await command(['daemon', 'upgrade', '--target-version', version]);
  const result = await applied;
  assert.equal(closed, false, 'fixed host lease must remain open across update');
  const after = JSON.parse(await fsp.readFile(path.join(data, 'daemon.pid'), 'utf8'));
  assert.equal(after.pid, record.pid);
  assert.equal(after.instanceId, record.instanceId);
  const rolledBack = observeOperation(
    (op) =>
      op.targetVersion === failedVersion && ['rolled-back', 'blocked', 'failed'].includes(op.phase)
  );
  await command(['daemon', 'upgrade', '--target-version', failedVersion]);
  const rollback = await rolledBack;
  assert.equal(rollback.phase, 'rolled-back');
  assert.equal(closed, false, 'rollback must retain the same Host lease');
  const selected = JSON.parse(
    await fsp.readFile(path.join(data, 'daemon-managed', 'selected.json'), 'utf8')
  );
  const updatedManifest = JSON.parse(
    await fsp.readFile(path.join(updated.directory, 'manifest.json'), 'utf8')
  );
  assert.equal(
    selected.digest,
    updatedManifest.capsule.contentSha256,
    'rollback selection must survive a service restart'
  );
  const output = {
    rollback: rollback.phase,
    result: 'PASS',
    scope:
      'actual OSS daemon install, native binding+Worker probe, managed update and clean candidate rollback with empty initial PATH; ad-hoc signing only',
    root,
    version,
    operation: result.phase,
    rootPidUnchanged: true,
    capsuleBytes: fs.statSync(updated.output).size,
    gzipBytes: fs.statSync(path.join(updated.directory, 'daemon.gz')).size,
    nodeGzipBytes: fs.statSync(path.join(updated.directory, 'node.gz')).size,
  };
  await fsp.writeFile(path.join(root, 'result.json'), JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output));
} finally {
  monitor?.destroy();
  if (started) {
    try {
      await command(['daemon', 'stop']);
    } catch (error) {
      console.error('Owned fixture stop failed:', error.message);
    }
  }
  await new Promise((resolve) => server.close(resolve));
}

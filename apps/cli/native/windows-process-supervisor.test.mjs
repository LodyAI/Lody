import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { before, after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const cliRoot = fileURLToPath(new URL('../', import.meta.url));
let scratch;
let binary;

function bounded(promise, timeoutMs = 15_000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Process fixture deadline exceeded')), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function processExit(child) {
  const result = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  void result.catch(() => {});
  return result;
}

function readLines(stream) {
  const lines = createInterface({ input: stream });
  const iterator = lines[Symbol.asyncIterator]();
  return {
    async next() {
      const result = await bounded(iterator.next());
      assert.equal(result.done, false, 'Process closed before expected output');
      return result.value;
    },
    close() {
      lines.close();
    },
  };
}

async function stopOwned(child, exit) {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await bounded(exit);
}

function startSupervisor(t, executable, args, env = process.env) {
  const child = spawn(binary, ['--owner-pid', String(process.pid), '--', executable, ...args], {
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    windowsHide: true,
    // Prevent Node's own parent-lifetime job from satisfying these assertions.
    detached: true,
    cwd: scratch,
    env,
  });
  const exit = processExit(child);
  const control = child.stdio[3];
  assert.ok(control);
  const status = readLines(control);
  t.after(async () => {
    try {
      await stopOwned(child, exit);
    } finally {
      status.close();
    }
  });
  return {
    child,
    control,
    status,
    exit,
    async prepare() {
      assert.deepEqual(JSON.parse(await status.next()), { type: 'ready', protocol: 1 });
      control.write('start\n');
      const prepared = JSON.parse(await status.next());
      assert.equal(prepared.type, 'prepared');
      assert.ok(Number.isSafeInteger(prepared.pid) && prepared.pid > 0);
      return prepared.pid;
    },
    async resume() {
      control.write('resume\n');
      assert.deepEqual(JSON.parse(await status.next()), { type: 'started' });
    },
  };
}

async function observeOwned(t, pids) {
  assert.equal(new Set(pids).size, pids.length);
  assert.ok(pids.every((pid) => Number.isSafeInteger(pid) && pid > 0));
  const script = String.raw`
    $ErrorActionPreference = 'Stop'
    $owned = @()
    try {
      foreach ($processId in @(${pids.join(',')})) {
        $item = [System.Diagnostics.Process]::GetProcessById($processId)
        $null = $item.Handle
        $owned += $item
        if ($item.HasExited) { throw 'Fixture exited before observation' }
      }
      [Console]::WriteLine('handles-ready')
      $command = [Console]::In.ReadLineAsync()
      if (-not $command.Wait(15000) -or $command.Result -ne 'verify') { throw 'Observation canceled' }
      foreach ($item in $owned) {
        if (-not $item.WaitForExit(5000)) { throw 'Owned process survived' }
        if ($item.ExitCode -eq 90) { throw 'Fixture watchdog fired' }
      }
      [Console]::WriteLine('all-exited')
    } finally {
      [Array]::Reverse($owned)
      $cleanupFailed = $false
      foreach ($item in $owned) {
        try {
          if (-not $item.HasExited) { $item.Kill() }
          if (-not $item.WaitForExit(5000)) { $cleanupFailed = $true }
        } catch { $cleanupFailed = $true } finally { $item.Dispose() }
      }
      if ($cleanupFailed) { throw 'Owned fixture cleanup failed' }
    }
  `;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const exit = processExit(child);
  const lines = readLines(child.stdout);
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  t.after(async () => {
    child.stdin.end();
    try {
      await bounded(exit);
    } finally {
      lines.close();
    }
  });
  assert.equal(await lines.next(), 'handles-ready');
  return {
    async verify() {
      child.stdin.end('verify\n');
      const result = await bounded(exit);
      assert.deepEqual(result, { code: 0, signal: null }, stderr);
      assert.equal(await lines.next(), 'all-exited', stderr);
    },
  };
}

// Every descendant stays alive independently of IPC disconnect/parent death.
// A timer is solely an orphan watchdog, never a test's synchronization mechanism.
const treeSource = String.raw`
  const { spawn } = require('node:child_process');
  function descendant(depth) {
    const { spawn } = require('node:child_process');
    setTimeout(() => process.exit(90), 60000);
    if (depth === 0) { process.send([process.pid]); return; }
    const child = spawn(process.execPath, ['-e', '(' + descendant.toString() + ')(' + (depth - 1) + ')'], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true, detached: true,
    });
    child.once('message', (pids) => process.send([process.pid, ...pids]));
  }
  const child = spawn(process.execPath, ['-e', '(' + descendant.toString() + ')(1)'], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true, detached: true,
  });
  child.once('message', (pids) => process.stdout.write(JSON.stringify([process.pid, ...pids]) + '\n'));
  process.stdin.once('data', (command) => {
    if (command.toString().startsWith('crash')) process.kill(process.pid, 'SIGKILL');
    else process.exit(23);
  });
  setTimeout(() => process.exit(90), 60000);
`;

async function runningTree(t) {
  const supervisor = startSupervisor(t, process.execPath, ['-e', treeSource]);
  const output = readLines(supervisor.child.stdout);
  t.after(() => output.close());
  const rootPid = await supervisor.prepare();
  await supervisor.resume();
  const pids = JSON.parse(await output.next());
  assert.equal(pids.length, 3);
  assert.equal(pids[0], rootPid);
  return { ...supervisor, pids };
}

void describe('native Windows process supervisor', { skip: process.platform !== 'win32' }, () => {
  before(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-supervisor-test-'));
    execFileSync(
      process.execPath,
      [path.join(cliRoot, 'scripts', 'build-windows-process-supervisor.mjs'), '--out-dir', scratch],
      { stdio: 'pipe', windowsHide: true, timeout: 120_000 }
    );
    binary = path.join(scratch, `windows-process-supervisor-win32-${process.arch}.exe`);
  });
  after(() => {
    if (!scratch) return;
    const relative = path.relative(os.tmpdir(), scratch);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  void it('preserves UTF-16 argv, inherited streams/env/cwd, and the target exit code', async (t) => {
    const args = [
      '',
      'a b',
      'quote"here',
      'trailing\\',
      '\\\\"quoted',
      '日本語 😀',
      '&|<>^%PATH%!',
    ];
    const source = String.raw`
      let input = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => { input += chunk; });
      process.stdin.on('end', () => {
        process.stdout.write(JSON.stringify({ args: process.argv.slice(1), cwd: process.cwd(),
          env: process.env.LODY_SUPERVISOR_TEST, input }));
        process.stderr.write('stderr-preserved');
        process.exitCode = 37;
      });
    `;
    const supervisor = startSupervisor(t, process.execPath, ['-e', source, '--', ...args], {
      ...process.env,
      LODY_SUPERVISOR_TEST: 'synthetic-value',
    });
    let stdout = '';
    let stderr = '';
    supervisor.child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    supervisor.child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    await supervisor.prepare();
    await supervisor.resume();
    supervisor.child.stdin.end('stdin-preserved');
    assert.deepEqual(await bounded(supervisor.exit), { code: 37, signal: null });
    assert.deepEqual(JSON.parse(stdout), {
      args,
      cwd: scratch,
      env: 'synthetic-value',
      input: 'stdin-preserved',
    });
    assert.equal(stderr, 'stderr-preserved');
  });

  void it('kills detached descendants when the target exits normally', async (t) => {
    const tree = await runningTree(t);
    const observer = await observeOwned(t, [tree.child.pid, ...tree.pids]);
    tree.child.stdin.write('exit\n');
    await observer.verify();
    assert.deepEqual(await bounded(tree.exit), { code: 23, signal: null });
  });

  void it('kills detached descendants when the native supervisor is killed', async (t) => {
    const tree = await runningTree(t);
    const observer = await observeOwned(t, [tree.child.pid, ...tree.pids]);
    tree.child.kill('SIGKILL');
    await observer.verify();
  });

  void it('kills detached descendants when the target crashes', async (t) => {
    const tree = await runningTree(t);
    const observer = await observeOwned(t, [tree.child.pid, ...tree.pids]);
    tree.child.stdin.write('crash\n');
    await observer.verify();
    assert.deepEqual(await bounded(tree.exit), { code: 1, signal: null });
  });

  void it('kills the job when the owner closes its control channel', async (t) => {
    const tree = await runningTree(t);
    const observer = await observeOwned(t, [tree.child.pid, ...tree.pids]);
    tree.control.end();
    await observer.verify();
    assert.deepEqual(await bounded(tree.exit), { code: 124, signal: null });
  });

  void it('returns every owned process to zero survivors across three lifetimes', async (t) => {
    for (const ending of ['exit', 'crash', 'supervisor-kill']) {
      const tree = await runningTree(t);
      const observer = await observeOwned(t, [tree.child.pid, ...tree.pids]);
      if (ending === 'supervisor-kill') tree.child.kill('SIGKILL');
      else tree.child.stdin.write(`${ending}\n`);
      // Settle all four original OS handles before starting the next lifetime.
      // This is an owned-fixture baseline, never a machine-wide process census.
      await observer.verify();
      await bounded(tree.exit);
    }
  });

  for (const phase of ['prepared', 'running']) {
    void it(`kills all owned processes after abrupt owner death (${phase})`, async (t) => {
      const ownerSource = String.raw`
        const { spawn } = require('node:child_process');
        const { createInterface } = require('node:readline');
        const child = spawn(process.argv[1], ['--owner-pid', String(process.pid), '--', process.execPath,
          '-e', process.argv[2]], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'], detached: true, windowsHide: true });
        const control = child.stdio[3];
        createInterface({ input: control }).on('line', (line) => {
          const status = JSON.parse(line);
          if (status.type === 'ready') control.write('start\n');
          if (status.type === 'prepared') {
            if (process.argv[3] === 'prepared') process.send([process.pid, child.pid, status.pid]);
            else control.write('resume\n');
          }
        });
        createInterface({ input: child.stdout }).on('line', (line) => {
          process.send([process.pid, child.pid, ...JSON.parse(line)]);
        });
        setTimeout(() => process.exit(90), 60000);
      `;
      const owner = spawn(process.execPath, ['-e', ownerSource, binary, treeSource, phase], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        windowsHide: true,
      });
      const exit = processExit(owner);
      t.after(() => stopOwned(owner, exit));
      const [pids] = await once(owner, 'message', { signal: AbortSignal.timeout(15_000) });
      assert.equal(pids.length, phase === 'prepared' ? 3 : 5);
      const observer = await observeOwned(t, pids);
      owner.kill('SIGKILL');
      await observer.verify();
    });
  }

  void it('kills a suspended child if the supervisor crashes before resume', async (t) => {
    const supervisor = startSupervisor(t, process.execPath, [
      '-e',
      'process.stdout.write("unexpected-run")',
    ]);
    let output = '';
    supervisor.child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    const pid = await supervisor.prepare();
    const observer = await observeOwned(t, [supervisor.child.pid, pid]);
    supervisor.child.kill('SIGKILL');
    await observer.verify();
    assert.equal(output, '');
  });

  void it('rejects native launch failure without emitting arguments or environment', async (t) => {
    const supervisor = startSupervisor(t, path.join(scratch, 'missing.exe'), ['synthetic-secret']);
    assert.deepEqual(JSON.parse(await supervisor.status.next()), { type: 'ready', protocol: 1 });
    supervisor.control.write('start\n');
    assert.deepEqual(JSON.parse(await supervisor.status.next()), {
      type: 'error',
      stage: 'create-process',
      code: 2,
    });
    assert.deepEqual(await bounded(supervisor.exit), { code: 125, signal: null });
  });

  void it('requires explicit parent authorization before creating a child', async (t) => {
    const supervisor = startSupervisor(t, process.execPath, [
      '-e',
      'process.stdout.write("unexpected-run")',
    ]);
    let output = '';
    supervisor.child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    assert.deepEqual(JSON.parse(await supervisor.status.next()), { type: 'ready', protocol: 1 });
    supervisor.control.write('invalid\n');
    assert.deepEqual(JSON.parse(await supervisor.status.next()), {
      type: 'error',
      stage: 'handshake',
      code: 13,
    });
    assert.deepEqual(await bounded(supervisor.exit), { code: 125, signal: null });
    assert.equal(output, '');
  });
});

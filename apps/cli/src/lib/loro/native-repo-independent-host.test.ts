import { createNativeLocalScheduleRegistryLegacy } from './native-schedule-registry-owner';
import { readLegacySqliteFlockSource } from './legacy-sqlite-flock-source';
import {
  ScheduleRegistryRowSchema,
  getScheduleRegistryFlockDocId,
  scheduleRegistryKeys,
} from '@lody/shared';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startProcessLegacy, type ProcessHandleLegacy } from '@lody/shared/node/process';
import {
  runCommandOk,
  processLayer,
  isPidAliveSyncLegacy,
  nodeProcessLive,
} from '@lody/shared/node/process';
import { Effect } from 'effect';
import {
  IndependentRepoControlChannel,
  readIndependentRun,
  independentRunPath,
  prepareIndependentRepoDirectory,
} from '@lody/shared/node/native-repo-independent-control';
import {
  IndependentNativeRepoHostLegacy,
  IndependentRepoOwnerFailure,
} from '@lody/shared/node/native-repo-independent-legacy';
import { loadNativeRepoSdkCompatibility } from '@lody/shared/node/native-repo-sdk-compatibility';
import { resolveLocalIndependentRepo } from '@lody/shared/node/native-repo-independent-paths';
import { LocalNativeRepoLeaseServiceLegacy } from '../../../../electron/src/main/services/local-native-repo-lease';
import type { ElectronLocalPlatformSnapshot } from '@lody/shared/electron-ipc';
import { LoroRepo } from 'loro-repo';
import { NativeFileIndexPilotLegacy } from './native-file-index-pilot';
import { NativeLocalWorkspaceCatalogLegacy } from './native-workspace-catalog-owner';
import { createCliSqliteRepoStore } from './sqlite-repo-store';
import { Flock } from '@loro-dev/flock-wasm';
import { NativeRepoMigrationJournal } from './native-repo-migration';
import {
  createNativeRoomMigrationCoordinatorLegacy,
  NativeRoomMigrationAdmission,
} from './native-repo-room-migration';
import { readNativeWorkspaceFlockOwner } from '../../../../electron/src/main/services/native-workspace-routing';
import { publishCodeCollabFileIndexFlock } from '../code-collab/code-collab-flock-publish';
import { getCodeCollabFileIndexFlockDocId, type WorkspaceId, type SessionId } from '@lody/shared';

const cliDir = path.resolve(import.meta.dirname, '../../..');
const roots = new Set<string>();
const clients = new Set<Client>();
const facades = new Set<IndependentNativeRepoHostLegacy>();
const desktopLeases = new Set<LocalNativeRepoLeaseServiceLegacy>();
const pilotCleanups: Array<() => Promise<unknown>> = [];
let output: string;

beforeAll(async () => {
  output = path.join(cliDir, 'node_modules/.cache', `independent-native-${randomUUID()}`);
  await fs.mkdir(output, { recursive: true });
  await build({
    entryPoints: {
      'native-repo-independent-host': path.join(
        import.meta.dirname,
        'native-repo-independent-host-entry.ts'
      ),
      'native-repo-independent-engine': path.join(
        import.meta.dirname,
        'native-repo-independent-engine-entry.ts'
      ),
      client: path.join(import.meta.dirname, 'native-repo-independent-client.test-support.ts'),
    },
    outdir: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node26',
    sourcemap: false,
    banner: {
      js: "import { createRequire as __fixtureRequire } from 'node:module'; import { isMainThread as __main, workerData as __data } from 'node:worker_threads'; import { writeFileSync as __write } from 'node:fs'; import { join as __join } from 'node:path'; const require = __fixtureRequire(import.meta.url); if (!__main && __data?.dataDir) __write(__join(__data.dataDir, 'fixture-network-env.json'), JSON.stringify({NO_PROXY:process.env.NO_PROXY, no_proxy:process.env.no_proxy, httpProxyPresent:process.env.HTTP_PROXY!==undefined, secretPresent:process.env.LODY_FIXTURE_SECRET!==undefined}));",
    },
    plugins: [
      {
        name: 'shared-source',
        setup(builder) {
          builder.onResolve({ filter: /^@loro-dev\/loro-repo-engine$/ }, () => ({
            path: createRequire(path.join(cliDir, 'package.json')).resolve(
              '@loro-dev/loro-repo-engine'
            ),
            external: true,
          }));
          builder.onResolve({ filter: /^@lody\/shared\/node\// }, (args) => ({
            path: path.resolve(
              cliDir,
              '../../packages/shared/src/node',
              `${args.path.split('/').at(-1)}.ts`
            ),
          }));
        },
      },
    ],
  });
});

afterAll(async () => {
  // Failed release retains synthetic data and compiled entries for recovery.
  if (roots.size === 0) await fs.rm(output, { recursive: true, force: true });
});

afterEach(async () => {
  const failures: unknown[] = [];
  for (const client of clients) {
    try {
      await client.close();
    } catch (error) {
      failures.push(error);
    }
  }
  clients.clear();
  for (const facade of facades) {
    try {
      await facade.close();
    } catch (error) {
      failures.push(error);
    }
  }
  facades.clear();
  for (const lease of desktopLeases) {
    try {
      await lease.close();
    } catch (error) {
      failures.push(error);
    }
  }
  desktopLeases.clear();
  for (const cleanup of pilotCleanups.reverse()) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  pilotCleanups.length = 0;
  // Never erase a directory while a launched control owner might still write.
  if (failures.length)
    throw new AggregateError(failures, 'Independent host fixture cleanup failed');
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
  roots.clear();
});

type Reply = {
  type: string;
  id?: number;
  result?: {
    value?: unknown;
    found?: boolean;
    closed?: boolean;
    retired?: boolean;
    ownedExecutionTreeStillAlive?: boolean;
  };
  clientPid?: number;
  pid?: number;
  engineRunId?: string;
  controlId?: string;
  launcherPid?: number;
};

class Client {
  readonly process: ProcessHandleLegacy;
  private lines: Reply[] = [];
  private waiters: Array<{
    match: (reply: Reply) => boolean;
    resolve: (reply: Reply) => void;
    reject: (error: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private id = 0;
  private closed = false;
  constructor(
    readonly dataDir: string,
    binding = 'synthetic-account/workspace',
    brokered = false,
    networkEnvironment: Record<string, string> = {}
  ) {
    this.process = startProcessLegacy({
      command: process.execPath,
      args: [
        path.join(output, 'client.js'),
        dataDir,
        path.join(output, 'native-repo-independent-host.js'),
        binding,
        ...(brokered ? ['brokered-v1'] : []),
      ],
      options: {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...networkEnvironment },
      },
      processGroup: true,
      onSpawned: (child) => {
        let buffered = '';
        child.stdout?.on('data', (chunk) => {
          buffered += chunk.toString('utf8');
          for (;;) {
            const end = buffered.indexOf('\n');
            if (end < 0) break;
            const reply = JSON.parse(buffered.slice(0, end)) as Reply;
            buffered = buffered.slice(end + 1);
            const waiter = this.waiters.find((waiter) => waiter.match(reply));
            if (waiter) {
              this.waiters.splice(this.waiters.indexOf(waiter), 1);
              clearTimeout(waiter.timer);
              waiter.resolve(reply);
            } else this.lines.push(reply);
          }
        });
        const ended = () => {
          for (const waiter of this.waiters.splice(0)) {
            clearTimeout(waiter.timer);
            waiter.reject(new Error('Synthetic client exited before reply'));
          }
        };
        child.once('error', ended);
        child.once('exit', ended);
      },
    });
    clients.add(this);
  }
  next(match: (reply: Reply) => boolean): Promise<Reply> {
    const index = this.lines.findIndex(match);
    if (index >= 0) return Promise.resolve(this.lines.splice(index, 1)[0] as Reply);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Synthetic independent client reply deadline')),
        20_000
      );
      this.waiters.push({ match, resolve, reject, timer });
    });
  }
  ready() {
    return this.next((reply) => reply.type === 'ready' || reply.type === 'failed');
  }
  request(op: string, key?: string, value?: string) {
    const id = ++this.id;
    const reply = this.next((reply) => reply.id === id || reply.type === 'failed');
    this.process.child.stdin?.write(JSON.stringify({ id, op, key, value }) + '\n');
    return reply;
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    try {
      const alreadyExited =
        this.process.child.exitCode !== null || this.process.child.signalCode !== null;
      if (!alreadyExited) {
        const reply = await this.request('close');
        if (reply.type !== 'reply') throw new Error('Synthetic independent client close failed');
        expect(reply.result?.ownedExecutionTreeStillAlive).toBe(false);
      }
      const exit = await this.process.exited;
      if (exit.code !== 0) throw new Error('Synthetic independent client failed');
    } catch (error) {
      await this.process.terminate({ graceMs: 0, killWaitMs: 5_000 });
      throw error;
    }
  }
  async crashClient() {
    this.closed = true;
    await this.process.terminate({ graceMs: 0, killWaitMs: 5_000 });
  }
}

async function dataDirectory() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-independent-'));
  roots.add(root);
  return path.join(root, 'data');
}

async function brokerDataDirectory() {
  const dataDir = await dataDirectory();
  if (process.platform === 'win32') {
    // Synthetic test root only: make its boundary independent of a CI runner's
    // TEMP ACL. Production never rewrites an existing profile's permissions.
    const script = `$ErrorActionPreference='Stop';$p=[Console]::In.ReadToEnd();$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=[System.Security.AccessControl.DirectorySecurity]::new();$acl.SetAccessRuleProtection($true,$false);$acl.SetOwner($sid);$rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow');$acl.AddAccessRule($rule);Set-Acl -LiteralPath $p -AclObject $acl`;
    await Effect.runPromise(
      runCommandOk({
        command: path.win32.join(
          process.env.SystemRoot!,
          'System32/WindowsPowerShell/v1.0/powershell.exe'
        ),
        args: [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(script, 'utf16le').toString('base64'),
        ],
        input: path.dirname(dataDir),
        timeout: '5 seconds',
        maxOutputBytes: 1024,
      }).pipe(Effect.provide(processLayer({})))
    );
  }
  return dataDir;
}

it.skipIf(process.platform === 'win32')(
  'passes explicit proxy exclusions to the actual engine worker without proxy or secret inheritance',
  async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'independent-network-env-'));
    roots.add(dataDir);
    const client = new Client(dataDir, 'synthetic-network/workspace', false, {
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: 'selected.invalid',
      HTTP_PROXY: 'http://proxy.invalid:8080',
      LODY_FIXTURE_SECRET: 'synthetic-not-forwarded',
    });
    const ready = await client.ready();
    expect(ready.type).toBe('ready');
    expect(
      JSON.parse(await fs.readFile(path.join(dataDir, 'fixture-network-env.json'), 'utf8'))
    ).toEqual({
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: 'selected.invalid',
      httpProxyPresent: false,
      secretPresent: false,
    });
  }
);

describe('authenticated whole-workspace retirement', () => {
  it('retries the captured workspace retirement after its original application Scope already closed', async () => {
    const dataDir = await dataDirectory();
    let refuseProbe = false;
    const facade = new IndependentNativeRepoHostLegacy(
      {
        dataDir,
        binding: 'synthetic-account/workspace',
        executable: process.execPath,
        entry: path.join(output, 'native-repo-independent-host.js'),
      },
      {
        nodeProcess: {
          ...nodeProcessLive,
          kill: (pid, signal) => {
            if (refuseProbe && signal === 0)
              throw Object.assign(new Error('Synthetic unavailable original PID proof'), {
                code: 'EPERM',
              });
            return nodeProcessLive.kill(pid, signal);
          },
        },
      }
    );
    facades.add(facade);
    const sdk = await facade.client(),
      info = await facade.leaseInfo(sdk);
    const foreign = new Client(dataDir);
    expect((await foreign.ready()).pid).toBe(info.pid);
    await foreign.request('put', 'retry-original-run', 'persisted');
    refuseProbe = true;
    await expect(facade.retireWorkspace(sdk)).rejects.toThrow('owner failed');
    await facade.close();
    expect(isPidAliveSyncLegacy(info.pid)).toBe(true);
    expect((await foreign.request('read', 'retry-original-run')).result?.value).toBe('persisted');
    refuseProbe = false;
    await facade.retireWorkspace(sdk);
    expect(isPidAliveSyncLegacy(info.pid)).toBe(false);
    await foreign.close();
    const next = new Client(dataDir);
    expect((await next.ready()).engineRunId).not.toBe(info.engineRunId);
    expect((await next.request('read', 'retry-original-run')).result?.value).toBe('persisted');
    await facade.retireWorkspace(sdk);
    expect((await next.request('read', 'retry-original-run')).result?.value).toBe('persisted');
  });
  it('retires two real OS leases of the exact run, preserves another workspace, and never stops its successor', async () => {
    const dataDir = await dataDirectory();
    const first = new Client(dataDir),
      a = await first.ready();
    const second = new Client(dataDir),
      b = await second.ready();
    const sibling = new Client(await dataDirectory(), 'synthetic-account/other-workspace');
    const siblingReady = await sibling.ready();
    expect(a.pid).not.toBe(first.process.child.pid);
    expect(b.pid).toBe(a.pid);
    await first.request('put', 'retirement-proof', 'persisted');
    const run = await readIndependentRun(dataDir, 'synthetic-account/workspace');
    const stale = await IndependentRepoControlChannel.open({
      ...run,
      engineRunId: 'not-the-actual-run',
    });
    try {
      await expect(stale.request('retire_workspace')).rejects.toMatchObject({ code: 'protocol' });
    } finally {
      stale.destroy();
      await stale.lost;
    }
    expect((await second.request('read', 'retirement-proof')).result?.value).toBe('persisted');
    expect((await first.request('retire-workspace')).result?.retired).toBe(true);
    expect(isPidAliveSyncLegacy(a.pid!)).toBe(false);
    expect(isPidAliveSyncLegacy(siblingReady.pid!)).toBe(true);
    await sibling.request('put', 'unrelated', 'healthy');
    await second.close();
    const next = new Client(dataDir),
      nextReady = await next.ready();
    expect(nextReady.engineRunId).not.toBe(a.engineRunId);
    expect((await next.request('read', 'retirement-proof')).result?.value).toBe('persisted');
    expect((await first.request('retire-workspace')).result?.retired).toBe(true);
    await first.close(); // Captured retirement and cleanup cannot signal the successor.
    expect((await next.request('read', 'retirement-proof')).result?.value).toBe('persisted');
  }, 30_000);
});

describe('brokered independent host candidate (real OS clients; no product selection)', () => {
  it('confirms middle-launcher exit before sharing, survives execution tree termination, and restarts persisted data after last lease', async () => {
    const dataDir = await brokerDataDirectory();
    const first = new Client(dataDir, 'synthetic-account/workspace', true);
    const a = await first.ready();
    expect(a.launcherPid).toBeGreaterThan(0);
    expect(a.launcherPid).not.toBe(a.pid);
    expect(isPidAliveSyncLegacy(a.launcherPid!)).toBe(false);
    const second = new Client(dataDir, 'synthetic-account/workspace', true);
    const b = await second.ready();
    expect(b.pid).toBe(a.pid);
    expect(b.engineRunId).toBe(a.engineRunId);
    await first.request('put', 'brokered-write', 'acknowledged');
    await first.crashClient(); // Actual Windows /T or POSIX execution-tree kill.
    expect((await second.request('read', 'brokered-write')).result?.value).toBe('acknowledged');
    expect((await readIndependentRun(dataDir, 'synthetic-account/workspace')).engineRunId).toBe(
      a.engineRunId
    );
    await second.close();
    await expect(fs.access(independentRunPath(dataDir))).rejects.toMatchObject({ code: 'ENOENT' });
    const next = new Client(dataDir, 'synthetic-account/workspace', true);
    expect((await next.ready()).engineRunId).not.toBe(a.engineRunId);
    expect((await next.request('read', 'brokered-write')).result?.value).toBe('acknowledged');
    await next.close();
  }, 30_000);

  it('admits concurrent starters to one writer and rejects a forged private lease token', async () => {
    const dataDir = await brokerDataDirectory();
    const first = new Client(dataDir, 'synthetic-account/workspace', true);
    const second = new Client(dataDir, 'synthetic-account/workspace', true);
    const [a, b] = await Promise.all([first.ready(), second.ready()]);
    expect(a.pid).toBe(b.pid);
    expect(a.engineRunId).toBe(b.engineRunId);
    const run = await readIndependentRun(dataDir, 'synthetic-account/workspace');
    const forged = await IndependentRepoControlChannel.open({
      ...run,
      token: randomUUID().repeat(2),
    });
    try {
      await expect(forged.request('acquire')).rejects.toMatchObject({ code: 'unauthorized' });
    } finally {
      forged.destroy();
      await forged.lost;
    }
    await first.request('put', 'same-writer', 'retained');
    await first.close();
    expect((await second.request('read', 'same-writer')).result?.value).toBe('retained');
    await second.close();
  }, 30_000);
});

describe.skipIf(process.platform === 'win32')(
  'independent native data host (real OS clients)',
  () => {
    it('keeps the same writer after its launcher Scope/process exits and stops only after the last lease', async () => {
      const dataDir = await dataDirectory();
      const first = new Client(dataDir);
      const a = await first.ready();
      expect(a.type).toBe('ready');
      const second = new Client(dataDir);
      const b = await second.ready();
      expect(b.type).toBe('ready');
      expect(a.clientPid).not.toBe(b.clientPid);
      expect(a.pid).toBe(b.pid);
      expect(a.engineRunId).toBe(b.engineRunId);
      await first.request('put', 'from-main', 'main write');
      expect((await second.request('read', 'from-main')).result?.value).toBe('main write');
      await second.request('put', 'from-daemon', 'daemon write');
      expect((await first.request('read', 'from-daemon')).result?.value).toBe('daemon write');
      await first.close();
      await second.request('put', 'after-main-exit', 'still same writer');
      const run = await readIndependentRun(dataDir, 'synthetic-account/workspace');
      expect(run.engineRunId).toBe(a.engineRunId);
      await second.close();
      const third = new Client(dataDir);
      const c = await third.ready();
      expect(c.type).toBe('ready');
      expect(c.engineRunId).not.toBe(a.engineRunId);
      expect((await third.request('read', 'after-main-exit')).result?.value).toBe(
        'still same writer'
      );
    }, 30_000);

    it('concurrent starters converge on one fixed-mode host and one shared engine generation', async () => {
      const dataDir = await dataDirectory();
      const first = new Client(dataDir);
      const second = new Client(dataDir);
      const [a, b] = await Promise.all([first.ready(), second.ready()]);
      expect(a.type).toBe('ready');
      expect(b.type).toBe('ready');
      expect(a.pid).toBe(b.pid);
      expect(a.engineRunId).toBe(b.engineRunId);
      await first.request('put', 'concurrent', 'one writer');
      expect((await second.request('read', 'concurrent')).result?.value).toBe('one writer');
    }, 30_000);

    it('a killed launching process leaves the independent host alive for the other lease', async () => {
      const dataDir = await dataDirectory();
      const first = new Client(dataDir);
      const a = await first.ready();
      expect(a.type).toBe('ready');
      const second = new Client(dataDir);
      expect((await second.ready()).type).toBe('ready');
      await first.request('put', 'before-launcher-crash', 'acknowledged');
      await first.crashClient();
      expect((await second.request('read', 'before-launcher-crash')).result?.value).toBe(
        'acknowledged'
      );
      await second.request('put', 'after-launcher-crash', 'same independent host');
      expect((await readIndependentRun(dataDir, 'synthetic-account/workspace')).engineRunId).toBe(
        a.engineRunId
      );
    }, 30_000);

    it('recovers acknowledged data after SIGKILL and retired clients cannot kill the replacement generation', async () => {
      const dataDir = await dataDirectory();
      const first = new Client(dataDir);
      const a = await first.ready();
      expect(a.type).toBe('ready');
      const second = new Client(dataDir);
      expect((await second.ready()).type).toBe('ready');
      await first.request('put', 'before-crash', 'committed');
      await first.request('crash-host');
      await second.request('lost');
      const replacement = new Client(dataDir);
      const next = await replacement.ready();
      expect(next.type).toBe('ready');
      expect(next.engineRunId).not.toBe(a.engineRunId);
      expect((await replacement.request('read', 'before-crash')).result?.value).toBe('committed');
      await first.close();
      await second.close();
      await replacement.request('put', 'new-generation', 'not killed by old Scopes');
      expect((await replacement.request('read', 'new-generation')).result?.value).toBe(
        'not killed by old Scopes'
      );
    }, 30_000);

    it.skipIf(process.platform === 'win32')(
      'rejects bad authentication, public metadata, mismatched binding and unmarked data without disturbing an existing lease',
      async () => {
        const dataDir = await dataDirectory();
        const first = new Client(dataDir);
        expect((await first.ready()).type).toBe('ready');
        const run = await readIndependentRun(dataDir, 'synthetic-account/workspace');
        const channel = await IndependentRepoControlChannel.open({ ...run, token: 'wrong-token' });
        await expect(channel.request('acquire')).rejects.toThrow(/unauthorized/);
        channel.destroy();
        const modePath = path.join(dataDir, 'independent-mode.json');
        expect((await fs.stat(modePath)).mode & 0o777).toBe(0o600);
        const runPath = path.join(dataDir, 'independent-run.json');
        await fs.chmod(runPath, 0o644);
        try {
          await expect(readIndependentRun(dataDir, 'synthetic-account/workspace')).rejects.toThrow(
            /private_path/
          );
        } finally {
          await fs.chmod(runPath, 0o600);
        }
        await expect(
          prepareIndependentRepoDirectory(dataDir, 'different-account/workspace')
        ).rejects.toThrow(/binding_mismatch/);
        const unmarked = path.join(path.dirname(dataDir), 'unmarked');
        await fs.mkdir(unmarked, { mode: 0o700 });
        await fs.writeFile(path.join(unmarked, 'engine.json'), '{}', { mode: 0o600 });
        await expect(
          prepareIndependentRepoDirectory(unmarked, 'synthetic-account/workspace')
        ).rejects.toThrow(/requires_migration/);
        await first.request('put', 'after-rejection', 'still owned');
        expect((await first.request('read', 'after-rejection')).result?.value).toBe('still owned');
      },
      30_000
    );
  }
);

describe.skipIf(process.platform === 'win32')('independent host Legacy composition', () => {
  it('binds SDK artifact requirements to the authenticated live engine without replacing another owner', async () => {
    const dataDir = await dataDirectory();
    const sdk = await loadNativeRepoSdkCompatibility(import.meta.url);
    const options = {
      dataDir,
      binding: 'synthetic-artifact/workspace',
      executable: process.execPath,
      entry: path.join(output, 'native-repo-independent-host.js'),
    };
    const original = new IndependentNativeRepoHostLegacy(options);
    facades.add(original);
    const client = await original.client();
    const before = await original.leaseInfo(client);
    expect(before.sdkArtifactId).toBe(sdk?.artifactId);
    const room = { kind: 'flock' as const, id: 'artifact-room' };
    await client.createRoom('artifact-test', room);
    await client.flockBatch('artifact-test', room, [{ op: 'put', key: ['retained'], value: true }]);
    const mismatch = sdk?.artifactId === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64);
    const wrong = new IndependentNativeRepoHostLegacy({
      ...options,
      requiredSdkArtifactId: mismatch,
    });
    facades.add(wrong);
    await expect(wrong.client()).rejects.toBeInstanceOf(IndependentRepoOwnerFailure);
    await wrong.close();
    const actual = await readIndependentRun(dataDir, options.binding);
    expect(actual.engineRunId).toBe(before.engineRunId);
    expect(actual.controlId).toBe(before.controlId);
    // Discovery alone grants nothing: the live controller must attest the same
    // artifact over the authenticated lease channel for this exact run.
    await fs.writeFile(
      independentRunPath(dataDir),
      JSON.stringify({ ...actual, sdkArtifactId: mismatch })
    );
    try {
      const forged = new IndependentNativeRepoHostLegacy({
        ...options,
        requiredSdkArtifactId: mismatch,
      });
      facades.add(forged);
      await expect(forged.client()).rejects.toBeInstanceOf(IndependentRepoOwnerFailure);
      await forged.close();
    } finally {
      await fs.writeFile(independentRunPath(dataDir), JSON.stringify(actual));
    }

    expect((await client.flockGet('artifact-test', room, ['retained'])).value).toBe(true);
    const peer = new IndependentNativeRepoHostLegacy({
      ...options,
      ...(sdk ? { requiredSdkArtifactId: sdk.artifactId } : {}),
    });
    facades.add(peer);
    const attached = await peer.client();
    expect((await peer.leaseInfo(attached)).engineRunId).toBe(before.engineRunId);
    expect((await peer.leaseInfo(attached)).sdkArtifactId).toBe(sdk?.artifactId);
    await original.close();
    expect((await attached.flockGet('artifact-test', room, ['retained'])).value).toBe(true);
    await peer.close();
  });

  it('main reads the real whole-room journal and a durable rollback fence before acknowledging renderer cutover', async () => {
    const dataRoot = await dataDirectory();
    const accountId = 'local:routing';
    const workspaceId = 'lw_routing';
    const binding = {
      accountId,
      workspaceId,
      roomId: `${workspaceId}:wf:workspace`,
      contentMode: 'plaintext' as const,
    };
    const selected = resolveLocalIndependentRepo({
      platform: 'local',
      dataRoot,
      accountId,
      workspaceId,
    });
    expect(readNativeWorkspaceFlockOwner(dataRoot, binding)).toBe('legacy');
    const host = new IndependentNativeRepoHostLegacy({
      ...selected,
      executable: process.execPath,
      entry: path.join(output, 'native-repo-independent-host.js'),
    });
    facades.add(host);
    const client = await host.client();
    const journal = new NativeRepoMigrationJournal(path.join(selected.directory, 'routes.sqlite3'));
    pilotCleanups.push(async () => journal.close());
    const journalBinding = JSON.stringify([accountId, workspaceId]);
    const room = { kind: 'flock' as const, id: binding.roomId };
    const flock = new Flock();
    flock.put(['opaque-future'], { retained: true }, 1);
    flock.delete(['deleted'], 2);
    const admission = new NativeRoomMigrationAdmission(journal, journalBinding);
    const migration = createNativeRoomMigrationCoordinatorLegacy({
      binding: journalBinding,
      namespace: workspaceId,
      targetGeneration: 'engine-0.1.0-v1',
      directory: selected.directory,
      dataDir: selected.dataDir,
      journal,
      client,
      admission,
      freezeExternalOwners: async () => {},
    });
    await migration.migrate([
      {
        room,
        sources: [{ sourceId: 'synthetic-renderer', snapshot: async () => flock.exportFile() }],
      },
    ]);
    expect(readNativeWorkspaceFlockOwner(dataRoot, binding)).toBe('native');
    const cliCatalog = new NativeLocalWorkspaceCatalogLegacy({
      accountId,
      workspaceId: workspaceId as WorkspaceId,
      dataRoot,
      launch: {
        executable: process.execPath,
        entry: path.join(output, 'native-repo-independent-host.js'),
      },
    });
    pilotCleanups.push(() => cliCatalog.close());
    expect(await cliCatalog.ready()).toBe(true);
    const catalogBinding = { accountId, workspaceId: workspaceId as WorkspaceId };
    await cliCatalog.catalog.execute(catalogBinding, {
      kind: 'put-mcp',
      entry: {
        id: 'synthetic-native-mcp' as import('@lody/shared').McpServerId,
        name: 'Native files',
        transport: 'stdio',
        connection: { transport: 'stdio', command: 'synthetic-files' },
        createdAt: 1,
        updatedAt: 1,
      },
    });
    expect(
      (await cliCatalog.catalog.read(catalogBinding)).servers.map((server) => server.name)
    ).toEqual(['Native files']);
    const route = journal.routeGroup(journalBinding, [room]);
    if (route.owner !== 'native') throw new Error('Expected native whole-room route');
    journal.beginRollbackGroup(journalBinding, [room], route.migrationId);
    expect(readNativeWorkspaceFlockOwner(dataRoot, binding)).toBe('frozen');
    expect(await cliCatalog.ready()).toBe(false);
    await expect(
      cliCatalog.catalog.execute(catalogBinding, {
        kind: 'delete-mcp',
        id: 'synthetic-native-mcp' as import('@lody/shared').McpServerId,
      })
    ).rejects.toThrow();
    expect(
      (await client.flockGet(workspaceId, room, ['mcpServer', 'synthetic-native-mcp'])).found
    ).toBe(true);
    expect(() =>
      new NativeRoomMigrationAdmission(journal, journalBinding).admit('native', [room])
    ).toThrow(/maintenance/);
  }, 30_000);
  it('moves the whole SR group with an explicit SR fence and rolls native edits durably back without touching WF', async () => {
    const dataRoot = await dataDirectory();
    const accountId = 'local:sr-owner';
    const workspaceId = 'lw_sr_owner' as WorkspaceId;
    const selected = resolveLocalIndependentRepo({
      platform: 'local',
      dataRoot,
      accountId,
      workspaceId,
    });
    const host = new IndependentNativeRepoHostLegacy({
      ...selected,
      executable: process.execPath,
      entry: path.join(output, 'native-repo-independent-host.js'),
    });
    facades.add(host);
    const client = await host.client();
    const room = { kind: 'flock' as const, id: getScheduleRegistryFlockDocId(workspaceId) };
    const wf = { kind: 'flock' as const, id: `${workspaceId}:wf:workspace` };
    await client.createRoom(workspaceId, wf);
    await client.flockBatch(workspaceId, wf, [{ op: 'put', key: ['sibling'], value: 'untouched' }]);
    const sqlite = await createCliSqliteRepoStore(
      workspaceId,
      undefined,
      path.join(dataRoot, 'legacy')
    );
    pilotCleanups.push(async () => sqlite.sqliteStore.close());
    const repo = await LoroRepo.create({ storageAdapter: sqlite.storageAdapter });
    pilotCleanups.push(() => repo.destroy());
    const legacy = await repo.openFlockDoc(room.id);
    const row = ScheduleRegistryRowSchema.parse({
      scheduleId: 'synthetic-sr',
      title: 'Synthetic SR',
      ownerId: accountId,
      machineId: 'machine',
      enabled: true,
      activationId: 'original',
      activeFrom: 1,
      trigger: { kind: 'manual' },
      destination: { kind: 'new_session' },
      createdAt: 1,
      updatedAt: 1,
      definitionFingerprint: 'a'.repeat(64),
      agentConfigId: 'agent',
    });
    legacy.flock.put(scheduleRegistryKeys.schedule(row.scheduleId), {
      ...row,
      future: { retained: true },
    });
    legacy.flock.put(['unknown-family', 'retained'], { opaque: true });
    legacy.flock.commit();
    await repo.persistFlockDocNow(room.id, legacy.flock);
    await repo.flush();
    const renderer = new Flock();
    renderer.put(scheduleRegistryKeys.manual(row.scheduleId, 'before-migration'), {
      scheduleId: row.scheduleId,
      actorId: accountId,
      activationId: row.activationId,
      manualRunId: 'before-migration',
      requestedAt: 2,
    });
    let freezeCount = 0;
    const owner = await createNativeLocalScheduleRegistryLegacy({
      accountId,
      workspaceId,
      dataRoot,
      getClient: () => host.client(),
      flushNative: async () => {
        await client.compactRoom(workspaceId, room);
      },
      freezeExternalOwners: async (id) => {
        expect(id).toBe(room.id);
        freezeCount++;
      },
    });
    pilotCleanups.push(() => owner.close());
    expect(owner.owner()).toBe('legacy');
    await expect(owner.registry.read()).rejects.toThrow(/pending|closed/);
    await owner.migrate([
      {
        sourceId: 'daemon-sqlite',
        snapshot: async () =>
          readLegacySqliteFlockSource({ databasePath: sqlite.dbPath, room }).snapshot,
      },
      { sourceId: 'renderer-sr', snapshot: async () => renderer.exportFile() },
    ]);
    expect(owner.owner()).toBe('native');
    expect((await owner.registry.read()).manuals).toHaveLength(1);
    expect(
      (await client.flockGet(workspaceId, room, ['unknown-family', 'retained'])).value
    ).toEqual({ opaque: true });
    await owner.registry.execute({ kind: 'publish', row: { ...row, title: 'Native edit' } });
    await owner.registry.flush();
    await owner.rollback({
      async mergeAndPersist(native) {
        const before = readLegacySqliteFlockSource({ databasePath: sqlite.dbPath, room }).snapshot;
        legacy.flock.strictImportFile(native);
        await repo.persistFlockDocNow(room.id, legacy.flock);
        await repo.flush();
        return {
          before,
          after: readLegacySqliteFlockSource({ databasePath: sqlite.dbPath, room }).snapshot,
        };
      },
    });
    expect(owner.owner()).toBe('legacy');
    await expect(owner.registry.read()).rejects.toThrow(/pending|closed/);
    expect(freezeCount).toBe(2);
    const restored = Flock.strictFromFile(
      readLegacySqliteFlockSource({ databasePath: sqlite.dbPath, room }).snapshot
    );
    expect(restored.get(scheduleRegistryKeys.schedule(row.scheduleId))).toMatchObject({
      title: 'Native edit',
      future: { retained: true },
    });
    expect(
      restored.get(scheduleRegistryKeys.manual(row.scheduleId, 'before-migration'))
    ).toBeDefined();
    expect((await client.flockGet(workspaceId, wf, ['sibling'])).value).toBe('untouched');
  }, 30_000);

  it('recovers a mounted native index observer after its SDK connection closes without restarting the data host', async () => {
    const directory = await dataDirectory();
    const workspaceId = 'lw_observer' as WorkspaceId;
    const ownerSessionId = 'synthetic-observer' as SessionId;
    const binding = 'synthetic-observer-binding';
    const launch = {
      binding,
      executable: process.execPath,
      entry: path.join(output, 'native-repo-independent-host.js'),
    };
    const keepAlive = new IndependentNativeRepoHostLegacy({
      dataDir: path.join(directory, 'engine'),
      ...launch,
    });
    facades.add(keepAlive);
    await keepAlive.client();
    const before = await keepAlive.leaseInfo();
    const sqlite = await createCliSqliteRepoStore(
      workspaceId,
      undefined,
      path.join(directory, 'legacy')
    );
    pilotCleanups.push(async () => sqlite.sqliteStore.close());
    const repo = await LoroRepo.create({ storageAdapter: sqlite.storageAdapter });
    pilotCleanups.push(() => repo.destroy());
    const pilot = new NativeFileIndexPilotLegacy({
      directory,
      workspaceId,
      userId: 'local:observer',
      mode: 'native',
      repo,
      independentHost: launch,
    });
    pilotCleanups.push(() => pilot.close());
    const roomId = getCodeCollabFileIndexFlockDocId(workspaceId, ownerSessionId);
    await publishCodeCollabFileIndexFlock({
      store: await pilot.store(ownerSessionId),
      flockDocId: roomId,
      fileIndex: { 'initial.txt': true },
      updatedAtMs: 1,
      reconcileRemote: false,
    });
    pilot.markPublished(ownerSessionId);
    let firstReady!: () => void;
    let recovered!: () => void;
    let finalReady!: () => void;
    const initial = new Promise<void>((resolve) => {
      firstReady = resolve;
    });
    const recovery = new Promise<void>((resolve) => {
      recovered = resolve;
    });
    const final = new Promise<void>((resolve) => {
      finalReady = resolve;
    });
    let sawLoadingAfterReady = false;
    let hadReady = false;
    const observation = await pilot.source.subscribe(ownerSessionId, (state) => {
      if (state.status === 'loading' && hadReady) sawLoadingAfterReady = true;
      if (state.status !== 'ready') return;
      hadReady = true;
      if (state.fileIndex['initial.txt']) {
        firstReady();
        if (sawLoadingAfterReady) recovered();
      }
      if (state.fileIndex['after-flap.txt']) finalReady();
    });
    pilotCleanups.push(async () => observation?.release());
    await initial;
    // Inject a real socket failure at the private owner, retaining the View lease.
    const privateOwner = (pilot as unknown as { host: IndependentNativeRepoHostLegacy }).host;
    await (await privateOwner.client()).close();
    await recovery;
    expect((await privateOwner.leaseInfo()).engineRunId).toBe(before.engineRunId);
    await publishCodeCollabFileIndexFlock({
      store: await pilot.store(ownerSessionId),
      flockDocId: roomId,
      fileIndex: { 'after-flap.txt': true },
      updatedAtMs: 2,
      reconcileRemote: false,
    });
    await final;
    expect((await privateOwner.leaseInfo()).pid).toBe(before.pid);
    const current = await privateOwner.client();
    const subscribe = current.flockSubscribe.bind(current);
    current.flockSubscribe = async (...args: Parameters<typeof current.flockSubscribe>) => {
      const handle = await subscribe(...args);
      const release = handle.unsubscribe.bind(handle);
      let lostAck = true;
      handle.unsubscribe = async () => {
        await release();
        if (lostAck) {
          lostAck = false;
          throw new Error('Synthetic unsubscribe ACK loss');
        }
      };
      return handle;
    };
    let secondReady!: () => void;
    const secondSnapshot = new Promise<void>((resolve) => {
      secondReady = resolve;
    });
    const second = await pilot.source.subscribe(ownerSessionId, (state) => {
      if (state.status === 'ready' && state.fileIndex['after-flap.txt']) secondReady();
    });
    pilotCleanups.push(async () => second?.release());
    await secondSnapshot;
    await expect(second!.release()).rejects.toThrow(/unconfirmed/);
    // SDK's second unsubscribe would be a local no-op. It is not proof that
    // the earlier server-side subscription retired; retain the failed owner.
    await expect(second!.release()).rejects.toThrow(/unconfirmed/);
    await current.close();
    await second!.release();
    expect((await privateOwner.leaseInfo()).engineRunId).toBe(before.engineRunId);
    // A View may release while its first subscribe ACK is still in flight.
    // Retain that late handle too when its unsubscribe acknowledgement is lost.
    const lateClient = await privateOwner.client();
    const lateSubscribe = lateClient.flockSubscribe.bind(lateClient);
    let acquired!: () => void;
    let finishAcquire!: () => void;
    const acquisitionStarted = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const acquireGate = new Promise<void>((resolve) => {
      finishAcquire = resolve;
    });
    lateClient.flockSubscribe = async (...args: Parameters<typeof lateClient.flockSubscribe>) => {
      const handle = await lateSubscribe(...args);
      const release = handle.unsubscribe.bind(handle);
      handle.unsubscribe = async () => {
        await release();
        throw new Error('Synthetic late unsubscribe ACK loss');
      };
      acquired();
      await acquireGate;
      return handle;
    };
    const late = await pilot.source.subscribe(ownerSessionId, () => {});
    pilotCleanups.push(async () => late?.release());
    await acquisitionStarted;
    const lateRelease = late!.release();
    finishAcquire();
    await expect(lateRelease).rejects.toThrow(/unconfirmed/);
    await expect(late!.release()).rejects.toThrow(/unconfirmed/);
    await lateClient.close();
    await late!.release();
  }, 30_000);
  it('the desktop data lease keeps the same engine alive after its daemon lease closes, and refuses classic ownership', async () => {
    const dataRoot = await dataDirectory();
    const snapshot = {
      userId: 'local:synthetic',
      workspace: {
        workspaceId: 'lw_synthetic',
        name: 'Synthetic',
        slug: null,
        role: 'owner',
      },
    } as ElectronLocalPlatformSnapshot;
    const selected = resolveLocalIndependentRepo({
      platform: 'local',
      accountId: snapshot.userId,
      workspaceId: snapshot.workspace.workspaceId,
      dataRoot,
    });
    const launch = () => ({
      executable: process.execPath,
      entry: path.join(output, 'native-repo-independent-host.js'),
    });
    const main = new LocalNativeRepoLeaseServiceLegacy({ dataRoot, requested: true, launch });
    desktopLeases.add(main);
    await Promise.all([main.ensure(snapshot), main.ensure(snapshot)]);
    const daemon = new IndependentNativeRepoHostLegacy({ ...selected, ...launch() });
    facades.add(daemon);
    const client = await daemon.client();
    const before = await daemon.leaseInfo(client);
    const room = { kind: 'flock' as const, id: 'composition:fi' };
    await client.createRoom('composition', room);
    await client.flockBatch('composition', room, [
      { op: 'put', key: ['value'], value: 'survives execution close' },
    ]);
    await daemon.close();
    expect((await readIndependentRun(selected.dataDir, selected.binding)).engineRunId).toBe(
      before.engineRunId
    );
    const reopened = new IndependentNativeRepoHostLegacy({ ...selected, ...launch() });
    facades.add(reopened);
    const next = await reopened.client();
    expect((await reopened.leaseInfo(next)).engineRunId).toBe(before.engineRunId);
    expect((await next.flockGet('composition', room, ['value'])).value).toBe(
      'survives execution close'
    );
    await reopened.close();
    await main.close();
    await expect(main.ensure(snapshot)).rejects.toThrow(/closed/);
    await fs.mkdir(selected.classicDirectory, { recursive: true });
    await fs.writeFile(
      path.join(selected.classicDirectory, 'routes.sqlite3'),
      'synthetic classic owner'
    );
    const refused = new LocalNativeRepoLeaseServiceLegacy({ dataRoot, requested: true, launch });
    desktopLeases.add(refused);
    await expect(refused.ensure(snapshot)).rejects.toThrow(/explicit ownership migration/);
  }, 30_000);
  const facade = (dataDir: string) => {
    const owner = new IndependentNativeRepoHostLegacy({
      dataDir,
      binding: 'synthetic-account/workspace',
      executable: process.execPath,
      entry: path.join(output, 'native-repo-independent-host.js'),
    });
    facades.add(owner);
    return owner;
  };
  it('retries a failed initial Layer only after its original acquisition has released', async () => {
    const dataDir = await dataDirectory();
    await fs.mkdir(dataDir, { mode: 0o755 });
    await fs.chmod(dataDir, 0o755);
    const owner = facade(dataDir);
    await expect(owner.client()).rejects.toBeInstanceOf(IndependentRepoOwnerFailure);
    await fs.chmod(dataDir, 0o700);
    const client = await owner.client();
    const room = { kind: 'flock' as const, id: 'composition:wf' };
    await client.createRoom('composition', room);
    await client.flockBatch('composition', room, [
      { op: 'put', key: ['retry'], value: 'usable after failure' },
    ]);
    expect((await client.flockGet('composition', room, ['retry'])).value).toBe(
      'usable after failure'
    );
  }, 30_000);
  it('replaces only a closed SDK connection without stopping a live last-leased engine, then joins close', async () => {
    const dataDir = await dataDirectory();
    const owner = facade(dataDir);
    const original = await owner.client();
    const before = await owner.leaseInfo(original);
    const room = { kind: 'flock' as const, id: 'composition:wf' };
    await original.createRoom('composition', room);
    await original.flockBatch('composition', room, [
      { op: 'put', key: ['before-flap'], value: 'acknowledged once' },
    ]);
    await original.close();
    const [replacement, again] = await Promise.all([owner.client(), owner.client()]);
    expect(replacement).toBe(again);
    expect(replacement).not.toBe(original);
    const after = await owner.leaseInfo(replacement);
    expect(after.engineRunId).toBe(before.engineRunId);
    expect(after.pid).toBe(before.pid);
    expect(after.clientGeneration).not.toBe(before.clientGeneration);
    await expect(owner.leaseInfo(original)).rejects.toThrow(/client generation changed/);
    expect((await replacement.flockGet('composition', room, ['before-flap'])).value).toBe(
      'acknowledged once'
    );
    await Promise.all([owner.close(), owner.close()]);
    await expect(owner.client()).rejects.toThrow(/composition is closed/);
    const reopened = facade(dataDir);
    const next = await reopened.client();
    expect((await reopened.leaseInfo(next)).engineRunId).not.toBe(before.engineRunId);
    expect((await next.flockGet('composition', room, ['before-flap'])).value).toBe(
      'acknowledged once'
    );
  }, 30_000);
});

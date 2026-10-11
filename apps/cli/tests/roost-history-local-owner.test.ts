import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { Identity } from '@loro-dev/roost';
import { fromApplicationJson } from '@loro-dev/roost/lody-history';
import { createRoostHistoryReader } from '@lody/shared/session-data';
import { createRoostReadPort } from '../src/session/roost-history-port';
import { RoostNativeClient } from '@loro-dev/roost-node';
import { reportRoostHistoryFailure } from '../src/session/roost-history-diagnostics';
import {
  loadRoostOwnerSeedLegacy,
  roostIdentityDatabasePath,
} from '../src/session/roost-writer-identity';

// Any return to a mandatory credential-store path must fail these real opens.
vi.mock('@napi-rs/keyring', () => {
  throw new Error('Synthetic headless host: system credential store is unavailable');
});

describe('application-managed Roost writer identity', () => {
  it('persists a replica identity and reopens sealed, branched history without a credential store', async () => {
    const { RoostHistoryGeneration } = await import('../src/session/roost-history-generation');
    const directory = await mkdtemp(join(tmpdir(), 'lody-roost-identity-'));
    const dbPath = join(directory, 'history.db');
    let client: RoostNativeClient | undefined;
    try {
      const seed = await loadRoostOwnerSeedLegacy(dbPath);
      const owner = Identity.fromSeed(seed).owner();
      client = new RoostNativeClient({
        dbPath,
        seed,
        allowedOwners: [owner],
        clockMs: 1_700_000_000_000n,
        maxQueuedRequests: 16,
        maxQueuedBytes: 8 * 1024 * 1024,
      });
      await client.ready;
      const generation = new RoostHistoryGeneration(client, owner, 'shared-session');
      await generation.replace(
        [
          {
            id: 'member-a-input',
            role: 'user',
            userId: 'member-a',
            author: { v: 1, kind: 'human', userId: 'member-a' },
            timestamp: '2026-10-11T00:00:00.000Z',
            items: [{ type: 'text', text: 'Synthetic first member input' }],
            finished: true,
          },
          {
            id: 'member-b-input',
            role: 'user',
            userId: 'member-b',
            author: { v: 1, kind: 'human', userId: 'member-b' },
            timestamp: '2026-10-11T00:00:01.000Z',
            items: [{ type: 'text', text: 'Synthetic second member input' }],
            finished: true,
          },
        ],
        'synthetic-branch'
      );
      const before = await generation.history.readActiveBranch('shared-session');
      expect(before.messages).toHaveLength(2);
      await client.close();
      client = undefined;

      const restored = await loadRoostOwnerSeedLegacy(dbPath);
      expect(restored).toEqual(seed);
      client = new RoostNativeClient({
        dbPath,
        seed: restored,
        allowedOwners: [owner],
        clockMs: 1_700_000_000_000n,
        maxQueuedRequests: 16,
        maxQueuedBytes: 8 * 1024 * 1024,
      });
      await client.ready;
      const reopened = new RoostHistoryGeneration(client, owner, 'shared-session');
      await reopened.resolve();
      const after = await reopened.history.readActiveBranch('shared-session');
      expect(after).toEqual(before);
      const reader = createRoostHistoryReader(
        createRoostReadPort(reopened.history, () => ({
          initial: reopened.history.readProjectedMessages(),
          unsubscribe: () => {},
        }))
      );
      expect((await reader.readAll()).map(({ userId, author }) => ({ userId, author }))).toEqual([
        { userId: 'member-a', author: { v: 1, kind: 'human', userId: 'member-a' } },
        { userId: 'member-b', author: { v: 1, kind: 'human', userId: 'member-b' } },
      ]);
      if (process.platform !== 'win32') {
        expect((await stat(roostIdentityDatabasePath(dbPath))).mode & 0o777).toBe(0o600);
      }
    } finally {
      await client?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('serializes first enrollment across independent workers and isolates different replicas', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lody-roost-identity-race-'));
    const dbPath = join(directory, 'history.db');
    const moduleUrl = new URL('../src/session/roost-writer-identity.ts', import.meta.url).href;
    const tsxUrl = import.meta.resolve('tsx/esm/api');
    const workers = Array.from(
      { length: 3 },
      () =>
        new Worker(
          new URL(
            `data:text/javascript,${encodeURIComponent(`
              import { once } from 'node:events';
              import { parentPort, workerData } from 'node:worker_threads';
              import { tsImport } from ${JSON.stringify(tsxUrl)};
              const { loadRoostOwnerSeedLegacy } = await tsImport(workerData.moduleUrl, {
                parentURL: workerData.moduleUrl,
                tsconfig: false,
              });
              const start = once(parentPort, 'message');
              parentPort.postMessage({ kind: 'ready' });
              await start;
              const seed = await loadRoostOwnerSeedLegacy(workerData.dbPath);
              parentPort.postMessage({ kind: 'seed', value: Buffer.from(seed).toString('hex') });
              parentPort.close();
            `)}`
          ),
          { workerData: { dbPath, moduleUrl }, execArgv: [] }
        )
    );
    try {
      await Promise.all(workers.map((worker) => once(worker, 'message')));
      const results = workers.map((worker) => once(worker, 'message'));
      for (const worker of workers) worker.postMessage('start');
      const seeds = (await Promise.all(results)).map(([message]) => message.value as string);
      const restored = await loadRoostOwnerSeedLegacy(dbPath);
      expect(seeds).toEqual(Array(3).fill(Buffer.from(restored).toString('hex')));
      const another = await loadRoostOwnerSeedLegacy(join(directory, 'another.db'));
      expect(Identity.fromSeed(another).owner()).not.toEqual(Identity.fromSeed(restored).owner());
    } finally {
      await Promise.all(workers.map((worker) => worker.terminate()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['missing-row', 'damaged-seed', 'wrong-owner', 'future-version'] as const)(
    'refuses %s without replacing the saved identity or exposing signing material',
    async (damage) => {
      const directory = await mkdtemp(join(tmpdir(), 'lody-roost-identity-invalid-'));
      const dbPath = join(directory, 'history.db');
      try {
        const seed = await loadRoostOwnerSeedLegacy(dbPath);
        const filename = roostIdentityDatabasePath(dbPath);
        const db = new Database(filename);
        try {
          if (damage === 'missing-row') db.exec('DELETE FROM writer_identity');
          if (damage === 'damaged-seed') db.exec("UPDATE writer_identity SET seedHex = 'invalid'");
          if (damage === 'wrong-owner')
            db.prepare('UPDATE writer_identity SET ownerHex = ?').run('00'.repeat(32));
          if (damage === 'future-version') db.exec('UPDATE writer_identity SET version = 2');
        } finally {
          db.close();
        }
        const before = await readFile(filename);
        const error = await loadRoostOwnerSeedLegacy(dbPath).catch((failure: unknown) => failure);
        expect(error).toMatchObject({ code: 'identityInvalid' });
        const records: unknown[] = [];
        const diagnostic = reportRoostHistoryFailure(
          error,
          { stage: 'initialize' },
          {
            error: (_label: unknown, record: unknown) => records.push(record),
          }
        );
        expect(diagnostic.code).toBe('identityInvalid');
        expect(diagnostic.message).toContain('diagnostic=');
        expect(JSON.stringify(records)).not.toContain(Buffer.from(seed).toString('hex'));
        expect(diagnostic.message).not.toContain(directory);
        expect(await readFile(filename)).toEqual(before);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it('refuses legacy history and identity replacement, while retaining the original database', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lody-roost-identity-legacy-'));
    const dbPath = join(directory, 'history.db');
    try {
      const old = new RoostNativeClient({
        dbPath,
        seed: new Uint8Array(32).fill(13),
        allowedOwners: [Identity.fromSeed(new Uint8Array(32).fill(13)).owner()],
        clockMs: 1_700_000_000_000n,
        maxQueuedRequests: 16,
        maxQueuedBytes: 8 * 1024 * 1024,
      });
      try {
        await old.ready;
        await old.stream('synthetic-legacy').create([], '{}');
      } finally {
        await old.close();
      }
      const before = await readFile(dbPath);
      await expect(loadRoostOwnerSeedLegacy(dbPath)).rejects.toMatchObject({
        code: 'identityMissing',
      });
      expect(await readFile(dbPath)).toEqual(before);
      const freshPath = join(directory, 'fresh.db');
      const seed = await loadRoostOwnerSeedLegacy(freshPath);
      await expect(
        loadRoostOwnerSeedLegacy(freshPath, new Uint8Array(32).fill(23))
      ).rejects.toMatchObject({ code: 'identityConflict' });
      expect(await loadRoostOwnerSeedLegacy(freshPath)).toEqual(seed);
      await writeFile(freshPath, 'synthetic existing history');
      await rm(roostIdentityDatabasePath(freshPath));
      await expect(loadRoostOwnerSeedLegacy(freshPath)).rejects.toMatchObject({
        code: 'identityMissing',
      });
      expect(await readFile(freshPath, 'utf8')).toBe('synthetic existing history');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reports storage failure without creating a replacement writer', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lody-roost-identity-storage-'));
    try {
      const blocked = join(directory, 'not-a-directory');
      await writeFile(blocked, 'synthetic blocked application data');
      await expect(loadRoostOwnerSeedLegacy(join(blocked, 'history.db'))).rejects.toMatchObject({
        code: 'identityStorage',
      });
      expect(await readFile(blocked, 'utf8')).toBe('synthetic blocked application data');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('local Roost owner adapter', () => {
  const workerClient = (workerUrl: URL) =>
    new RoostNativeClient({
      dbPath: join(tmpdir(), 'synthetic-roost-worker.db'),
      seed: new Uint8Array(32).fill(7),
      allowedOwners: [],
      maxQueuedRequests: 4,
      maxQueuedBytes: 1024 * 1024,
      workerUrl,
    });
  const workerSource = (body: string) =>
    new URL(
      `data:text/javascript,${encodeURIComponent(
        `import { parentPort } from 'node:worker_threads'; ${body}`
      )}`
    );

  it('retains the original Worker initialization exception and its cause', async () => {
    const client = workerClient(
      workerSource(
        `throw new Error('synthetic Worker startup failure', { cause: new Error('synthetic missing dependency') });`
      )
    );
    try {
      await expect(client.ready).rejects.toMatchObject({
        code: 'workerFailed',
        cause: {
          message: 'synthetic Worker startup failure',
          cause: { message: 'synthetic missing dependency' },
        },
      });
      await client.exited;
      expect(client.failure?.cause).toMatchObject({ message: 'synthetic Worker startup failure' });
      expect(Object.keys(client.failure ?? {})).not.toContain('cause');
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it('keeps a real binding-load fault instead of reducing it to nativeUnavailable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lody-roost-load-fault-'));
    const workerUrl = new URL('worker.mjs', import.meta.resolve('@loro-dev/roost-node'));
    await writeFile(join(directory, 'worker.mjs'), await readFile(workerUrl));
    await writeFile(
      join(directory, 'binding.cjs'),
      `throw new Error('synthetic binding load failure', { cause: new Error('synthetic missing library') });`
    );
    const client = workerClient(pathToFileURL(join(directory, 'worker.mjs')));
    try {
      await expect(client.ready).rejects.toMatchObject({
        code: 'nativeUnavailable',
        cause: {
          message: 'synthetic binding load failure',
          cause: { message: 'synthetic missing library' },
        },
      });
    } finally {
      await client.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['throw', 'exit'] as const)(
    'preserves dispatched and queued outcomes after a Worker %s',
    async (kind) => {
      const client = workerClient(
        workerSource(`
      parentPort.postMessage({ kind: 'ready', owner: '00'.repeat(32) });
      parentPort.on('message', () => {
        ${kind === 'throw' ? "throw new Error('synthetic write failure');" : 'process.exit(23);'}
      });
    `)
      );
      try {
        await client.ready;
        const stream = client.stream('synthetic-history');
        const outcomes = await Promise.allSettled([
          stream.create([], '{}'),
          stream.latestTurnHeaders(1n),
        ]);
        const failed = outcomes.map((outcome) => {
          expect(outcome.status).toBe('rejected');
          if (outcome.status !== 'rejected') throw new Error('Worker failure was lost');
          return outcome.reason as Error;
        });
        expect(failed[0]).toMatchObject({ code: 'unknownOutcome' });
        expect(failed[1]).toMatchObject({ code: 'notDispatched' });
        const records: unknown[] = [];
        const logger = {
          error: (_label: unknown, record: unknown) => {
            records.push(record);
          },
        };
        const failure = reportRoostHistoryFailure(failed[0], { stage: 'write' }, logger);
        const queued = reportRoostHistoryFailure(failed[1], { stage: 'write' }, logger);
        expect(failure.diagnosticId).toBe(queued.diagnosticId);
        expect(failure.message).toContain('diagnostic=');
        expect(failure.message).not.toContain('synthetic write failure');
        expect(JSON.stringify(records)).toContain(
          kind === 'throw' ? 'synthetic write failure' : 'code 23'
        );
        await expect(stream.latestTurnHeaders(1n)).rejects.toMatchObject({
          code: 'closed',
          cause: { code: kind === 'throw' ? 'workerFailed' : 'workerExited' },
        });
        expect((await client.exited).code).toBe(kind === 'exit' ? 23 : 1);
      } finally {
        await client.close().catch(() => undefined);
      }
    }
  );

  it('projects physical successor segments into one logical Lody turn', async () => {
    const { NodeLodyHistory } = await import('@loro-dev/roost/lody-history');
    const directory = await mkdtemp(join(tmpdir(), 'lody-roost-local-'));
    const seed = new Uint8Array(32).fill(7);
    const identity = Identity.fromSeed(seed);
    const client = new RoostNativeClient({
      dbPath: join(directory, 'history.db'),
      seed,
      allowedOwners: [identity.owner()],
      clockMs: 1_700_000_000_000n,
      maxQueuedRequests: 16,
      maxQueuedBytes: 8 * 1024 * 1024,
    });

    try {
      await client.ready;
      const history = new NodeLodyHistory(client.stream('lody-adapter'), identity.owner());
      const accept = (businessId: string, segmentId: string, content: unknown) =>
        history.accept({
          kind: 'message' as const,
          businessId,
          segmentId,
          parents: [],
          content: fromApplicationJson(content),
        });

      await accept('user-1', '0', {
        role: 'user',
        timestamp: '2026-10-03T00:00:00.000Z',
        items: [{ type: 'text', text: 'hello' }],
      });
      await accept('assistant-1', 'primary', {
        role: 'assistant',
        timestamp: '2026-10-03T00:00:01.000Z',
        userTurnId: 'user-1',
        items: [{ type: 'text', text: 'first' }],
        finished: false,
      });
      await accept('assistant-1', 'late-output', {
        items: [{ type: 'text', text: 'late' }],
        finished: true,
      });

      const physical = await history.readProjectedMessages();
      const reader = createRoostHistoryReader(
        createRoostReadPort(history, () => ({
          initial: history.readProjectedMessages(),
          unsubscribe: () => {},
        }))
      );
      const logical = await reader.readAll();

      expect(physical).toHaveLength(3);
      expect(logical).toHaveLength(2);
      expect(logical[1]).toMatchObject({
        id: 'assistant-1',
        role: 'assistant',
        finished: true,
      });
      expect(logical[1]?.items).toEqual([
        { type: 'text', text: 'first' },
        { type: 'text', text: 'late' },
      ]);
    } finally {
      await client.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30000);
});

// Manual fixed-prefix dispatcher benchmark; excluded from default CI.
// Keep fixtures, persistence and report fields aligned with roost-validation.md.
import { it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { LoroRepo } from 'loro-repo';
import { SqliteRepoStore } from 'loro-repo/storage/sqlite';
import {
  getSessionRoomId,
  SessionStatusFactory,
  type SessionId,
  type SessionMeta,
  type SessionHistoryInput,
} from '@lody/shared';
import { hashHistoryEntryForVersion, hashText } from '@lody/shared/session-data';
import { SessionDocument } from '../src/lib/loro/doc';
import { getDefaultLogger } from '../src/utils/logger';
import { installRoostNodeSessionBackend } from '../src/session/roost-node-session';
import { createSessionBackend } from '../src/session/session-backend';
import { SessionDispatchWatcher } from '../src/session/session-dispatch-watcher';

const dir = process.env.LONG_BENCH_DIR;
assert.ok(dir && isAbsolute(dir), 'LONG_BENCH_DIR must be an absolute synthetic data directory');
const kind = process.env.LONG_BENCH_KIND;
assert.ok(kind === 'roost' || kind === 'loro');
const stage = process.env.LONG_BENCH_STAGE;
assert.ok(stage === 'prepare' || stage === 'measure' || stage === 'verify' || stage === 'ranges');
const count = Number(process.env.LONG_BENCH_PREFIX);
assert.ok(Number.isSafeInteger(count) && count > 0 && count % 2 === 0);
const sessionId = '00000000-0000-4000-8000-000000000003' as SessionId;
const room = getSessionRoomId(sessionId);
const timestamp = '2026-10-22T00:00:00.000Z';
const text = (seed: string, length: number) => {
  let result = '';
  for (let i = 0; result.length < length; i++)
    result += createHash('sha256').update(`${seed}/${i}`).digest('base64url');
  return result.slice(0, length);
};
const user = (id: string, handled = false): SessionHistoryInput => ({
  id,
  role: 'user',
  userId: 'test-user',
  timestamp,
  status: handled ? 'handled' : 'pending',
  read: handled,
  items: [{ type: 'text', text: text(id, 256) }],
  fileDiff: [],
});
const assistant = (id: string, userTurnId: string, ended = false): SessionHistoryInput => ({
  id,
  role: 'assistant',
  userTurnId,
  timestamp,
  finished: ended,
  ...(ended ? { endedAt: 42 } : {}),
  items: [
    { type: 'text', text: text(id, 1024) },
    {
      type: 'tool_call',
      toolCallId: `tool-${id}`,
      title: 'Synthetic output',
      status: 'completed',
      rawOutput: { text: text(`tool/${id}`, 16384) },
    },
  ],
  fileDiff: [],
});
const prefixEntry = (i: number) =>
  i % 2 === 0
    ? user(`user-${i / 2}`, true)
    : assistant(`assistant-${Math.floor(i / 2)}`, `user-${Math.floor(i / 2)}`, true);
const chunk = (value: string) => ({
  sessionId: 'synthetic-acp',
  update: {
    sessionUpdate: 'agent_message_chunk' as const,
    content: { type: 'text' as const, text: value },
  },
});
const stats = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: samples.length,
    p50Ms: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
    p95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0,
    maxMs: sorted.at(-1) ?? 0,
  };
};
const timer = async <T>(fn: () => T | Promise<T>) => {
  const start = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - start };
};
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, canonical(v)])
        )
      : value;

it('measures fixed-prefix durable dispatch and append scaling', async () => {
  await mkdir(dir, { recursive: true });
  if (stage === 'prepare')
    assert.equal((await readdir(dir)).length, 0, 'Prepare requires an empty directory');
  const started = performance.now();
  const cpu = process.cpuUsage();
  const trajectory: {
    phase: string;
    rss: number;
    heapUsed: number;
    heapTotal: number;
    external: number;
    arrayBuffers: number;
  }[] = [];
  const memory = (phase: string) => {
    const sample = { phase, ...process.memoryUsage() };
    trajectory.push(sample);
    assert.ok(sample.rss < 2 * 1024 ** 3, 'Benchmark exceeded the 2 GiB RSS budget');
  };
  memory('process-start');
  const control = new Database(join(dir, 'loro.db'));
  control.pragma('journal_mode = WAL');
  control.pragma('synchronous = FULL');
  const store = new SqliteRepoStore({ database: control, wal: false });
  if (kind === 'roost')
    installRoostNodeSessionBackend({
      dbPath: join(dir, 'history.db'),
      seed: new Uint8Array(32).fill(91),
    });
  const repo = await LoroRepo.create({ storageAdapter: store.storage });
  if (stage === 'prepare')
    await repo.upsertDocMeta(room, {
      id: sessionId,
      historyBackend: kind,
      userId: 'test-user',
      machineId: 'test-machine',
      cliType: 'builtin',
      agentType: 'codex',
      createdAt: timestamp,
      status: SessionStatusFactory.idle(),
    });
  const doc = new SessionDocument(repo, sessionId, (r) => repo.unloadDoc(r));
  const opened = await timer(async () => {
    doc.handle = await repo.openPersistedDoc(room);
    doc.composeSessionData(doc.handle.doc, undefined, { historyBackend: kind });
    return createSessionBackend(doc, { historyBackend: kind });
  });
  const backend = opened.value;
  memory('backend-open');
  const persist = async () => {
    assert.ok(doc.handle);
    await repo.persistDocNow(room, doc.handle.doc);
  };
  const size = async () => {
    const result: Record<string, number> = {};
    for (const file of ['loro.db', ...(kind === 'roost' ? ['history.db'] : [])]) {
      // The Rust-owned SQLite connection is never opened by better-sqlite3 here.
      result[file] = Number(
        execFileSync(
          'python3',
          [
            '-c',
            'import sqlite3,sys; c=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); print(c.execute("pragma page_count").fetchone()[0]*c.execute("pragma page_size").fetchone()[0]); c.close()',
            join(dir, file),
          ],
          { encoding: 'utf8' }
        )
      );
      for (const suffix of ['-wal', '-shm'])
        result[file + suffix] = await stat(join(dir, file + suffix)).then(
          (s) => s.size,
          () => 0
        );
    }
    return result;
  };
  const timings: Record<string, number[]> = {};
  const acknowledge: Record<string, number[]> = {};
  const controlPersist: Record<string, number[]> = {};
  const measure = async (name: string, action: () => Promise<unknown>, durable = false) => {
    const start = performance.now();
    const a = await timer(action);
    (acknowledge[name] ??= []).push(a.ms);
    if (durable) {
      const p = await timer(persist);
      (controlPersist[name] ??= []).push(p.ms);
    }
    (timings[name] ??= []).push(performance.now() - start);
    return a.value;
  };
  const result: Record<string, unknown> = {
    kind,
    stage,
    prefixMessages: count,
    prefixRounds: count / 2,
    initialMessages: count + 2,
    toolBytes: 16384,
    assistantTextBytes: 1024,
    userTextBytes: 256,
    chunks: 20,
    chunkBytes: 256,
    openMs: opened.ms,
    trajectory,
    timings,
    acknowledge,
    controlPersist,
  };
  try {
    result.initialStorage = await size();
    if (stage === 'prepare') {
      const imported = await timer(async () => {
        const history = Array.from({ length: count }, (_, i) => prefixEntry(i));
        const hashes = history.map((entry) => hashHistoryEntryForVersion(entry as never, 2));
        assert.equal(
          (
            await backend.applyHistoryImport({
              mode: 'initialize',
              replay: {
                history: history as never,
                turnHashes: hashes,
                hashVersion: 2,
                replayDigest: hashText(hashes.join('\n')),
                droppedNotifications: 0,
              },
            })
          ).status,
          'accepted'
        );
        await persist();
      });
      result.importMs = imported.ms;
      memory('post-import');
      await backend.appendHistoryTurn(user('active-user'));
      await persist();
      await backend.appendHistoryTurn(assistant('active-assistant', 'active-user'));
      await persist();
      if ('readDispatchHistory' in backend) {
        const repaired = await timer(() => backend.readDispatchHistory([]));
        result.initialRepairMs = repaired.ms;
      }
      await backend.flushLocalWrites();
      memory('post-index-preparation');
    } else {
      const latest = await measure('latestWindow', () =>
        backend.readHistoryDirectory(count - 18, count + 2)
      );
      assert.equal((latest as unknown[]).length, 20);
      memory('latest-window');
      if (stage === 'ranges') {
        const ranges: unknown[] = [];
        for (const [name, from] of [
          ['oldest', 0],
          ['middle', Math.floor(count / 2)],
          ['quarter', Math.floor(count / 4)],
        ] as const) {
          const samples: number[] = [];
          const readCpu = { user: 0, system: 0 };
          let contentDigest = '';
          for (let repeat = 0; repeat < 10; repeat++) {
            const before = process.cpuUsage();
            const read = await timer(async () => {
              const rows = await backend.readHistoryDirectory(from, from + 20);
              const entries = [];
              for (const row of rows) {
                assert.ok(row.turnId);
                const turn = await backend.readTurn(row.turnId);
                assert.equal(turn.state, 'ready');
                if (turn.state === 'ready') entries.push(turn.turn);
              }
              return entries;
            });
            const spent = process.cpuUsage(before);
            readCpu.user += spent.user;
            readCpu.system += spent.system;
            samples.push(read.ms);
            // Validate outside the timed read; no full-history materialization.
            assert.equal(read.value.length, 20);
            const content = read.value.map((entry, i) => {
              const expected = prefixEntry(from + i);
              assert.equal(entry.id, expected.id);
              assert.equal(entry.role, expected.role);
              assert.deepEqual(entry.items, expected.items);
              return { id: entry.id, role: entry.role, items: entry.items };
            });
            contentDigest = createHash('sha256')
              .update(JSON.stringify(canonical(content)))
              .digest('hex');
            memory(`${name}-${repeat}`);
          }
          ranges.push({
            name,
            from,
            coldMs: samples[0],
            warm: stats(samples.slice(1)),
            samples,
            cpu: readCpu,
            contentDigest,
          });
        }
        result.ranges = ranges;
        result.finalStorage = await size();
        return;
      }
      if (stage === 'measure') {
        const watcher = new SessionDispatchWatcher({
          logger: getDefaultLogger(),
          machineId: 'test-machine',
          workspaceId: 'test-workspace',
          workspaceDocument: { repo },
          executionService: {
            reconcileSteerHistory: async () => {},
            tryAcquireSessionRewriteConflictLease: () => () => {},
            isInboxInputCanceled: () => false,
          },
          userResolver: { resolve: async () => undefined, clear: () => {} },
          canUseMachine: async () => ({ outcome: 'allowed' }),
        } as never);
        const check = (
          watcher as unknown as {
            checkHistoryAndQueue(
              doc: SessionDocument,
              meta: SessionMeta
            ): Promise<{ turn: SessionHistoryInput | null }>;
          }
        ).checkHistoryAndQueue.bind(watcher);
        const meta = await doc.getMetaState();
        assert.ok(meta);
        for (let i = 0; i < 13; i++) {
          const selected = await measure(i === 0 ? 'firstDispatch' : 'warmDispatch', () =>
            check(doc, meta)
          );
          assert.deepEqual(
            (selected as { turn: SessionHistoryInput }).turn?.items,
            user('active-user').items
          );
          if ([0, 4, 8, 12].includes(i)) memory(`dispatch-${i}`);
        }
        const writeCpu = process.cpuUsage();
        for (let i = 0; i < 20; i++) {
          await measure(
            'textAppend',
            () =>
              backend.applyAgentBatch({
                targetAssistantEntryId: 'active-assistant',
                notifications: [chunk(text(`chunk/${i}`, 256))],
                operationIds: [`chunk-${i}`],
              }),
            true
          );
          if ([0, 9, 19].includes(i)) memory(`append-${i + 1}`);
        }
        result.appendCpu = process.cpuUsage(writeCpu);
        await measure(
          'finish',
          () =>
            backend.applyHistoryAction({
              kind: 'finish-assistant',
              turnId: 'active-assistant',
              endedAt: 42,
            }),
          true
        );
        await measure(
          'resume',
          () =>
            backend.openAssistantTurn({
              turnId: 'active-assistant',
              userTurnId: 'active-user',
              timestamp,
            }),
          true
        );
        const resumed = {
          targetAssistantEntryId: 'active-assistant',
          notifications: [chunk(text('resumed', 256))],
          operationIds: ['resumed'],
        };
        await measure('firstResumedAppend', () => backend.applyAgentBatch(resumed), true);
        await backend.applyAgentBatch(resumed);
        await persist(); // Same durable operation must be a no-op.
        await backend.applyHistoryAction({
          kind: 'finish-assistant',
          turnId: 'active-assistant',
          endedAt: 42,
        });
        await persist();
        memory('resumed-and-finished');
        await measure('userCreation', () => backend.appendHistoryTurn(user('next-user')), true);
        await measure(
          'assistantCreation',
          () => backend.appendHistoryTurn(assistant('next-assistant', 'next-user')),
          true
        );
        memory('after-creation');
        await measure('adjacentPage', async () => {
          const rows = await backend.readHistoryDirectory(count - 38, count - 18);
          for (const row of rows) {
            assert.ok(row.turnId);
            assert.equal((await backend.readTurn(row.turnId)).state, 'ready');
          }
        });
        await measure('targetedOldTurn', async () =>
          assert.equal((await backend.readTurn('user-0')).state, 'ready')
        );
        memory('before-full-validation');
      }
      const full = (await measure('fullHistory', () =>
        backend.readHistory()
      )) as SessionHistoryInput[];
      memory('after-full-materialization');
      assert.equal(full.length, count + 4);
      const hasher = createHash('sha256');
      for (const [i, entry] of full.entries()) {
        let expected =
          i < count
            ? prefixEntry(i)
            : i === count
              ? user('active-user')
              : i === count + 1
                ? assistant('active-assistant', 'active-user', true)
                : i === count + 2
                  ? user('next-user')
                  : assistant('next-assistant', 'next-user');
        if (i === count + 1) {
          // Streaming text after a tool has its own coalesced text item.
          expected = {
            ...expected,
            items: [
              ...expected.items,
              {
                type: 'text',
                text:
                  Array.from({ length: 20 }, (_, n) => text(`chunk/${n}`, 256)).join('') +
                  text('resumed', 256),
              },
            ],
          };
        }
        assert.equal(entry.id, expected.id);
        assert.equal(entry.role, expected.role);
        assert.deepEqual(entry.items, expected.items);
        hasher.update(
          JSON.stringify(canonical({ id: entry.id, role: entry.role, items: entry.items })) + '\n'
        );
      }
      result.businessDigest = hasher.digest('hex');
      memory('after-content-verification');
    }
    result.finalStorage = await size();
  } finally {
    result.cpu = process.cpuUsage(cpu);
    result.wallMs = performance.now() - started;
    result.stats = Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, stats(v)]));
    await doc.destroy({ preserveStatus: true });
    await repo.destroy();
    store.close();
    control.close();
    memory('after-release');
    await writeFile(join(dir, stage + '.json'), JSON.stringify(result, null, 2));
  }
}, 1800000);

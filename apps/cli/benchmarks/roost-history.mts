/**
 * Synthetic data-path benchmark using the production backends and ConversationView.
 * Run from apps/cli:
 * TSX_TSCONFIG_PATH=tsconfig.json node --import ./node_modules/tsx/dist/loader.mjs benchmarks/roost-history.mts
 * Uses the pinned npm native package. No user data,
 * transport, React, IndexedDB, or painting is involved. SQLite OS cache is warm;
 * each measured session/backend/view is new. Loro snapshot import is timed.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RoostNativeClient } from '@loro-dev/roost-node';
import { performance } from 'node:perf_hooks';
import { LoroRepo } from 'loro-repo';
import type { SessionHistory, SessionId } from '@lody/shared';
import { getSessionRoomId } from '@lody/shared';
import { Identity } from '@loro-dev/roost';
import {
  NodeLodyHistory,
  fromApplicationJson,
  type HistoryIdentity,
} from '@loro-dev/roost/lody-history';
import { SessionDocument } from '../src/lib/loro/doc';
import { installRoostNodeSessionBackend } from '../src/session/roost-node-session';
import { createConversationViewFromReader } from '../../../packages/components/src/lib/conversation-view/create-conversation-view-from-reader';
import { buildSessionDoc } from '../../../packages/components/tests/conversation-view-fixtures';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const clientModule = import.meta.resolve('@loro-dev/roost-node');
const nativeBinding = fileURLToPath(import.meta.resolve('@loro-dev/roost-node/native'));
const sizes = (process.env.BENCH_SIZES ?? '100,1000,10000').split(',').map(Number);
const samples = Number(process.env.BENCH_SAMPLES ?? 7);
const warmups = Number(process.env.BENCH_WARMUPS ?? 2);
const bodyBytes = Number(process.env.BENCH_BODY_BYTES ?? 4096);
const output = process.env.BENCH_OUTPUT ?? '/tmp/lody-roost-history-bench.json';
const structural = process.env.BENCH_STRUCTURAL === '1';
assert.ok(sizes.every((n) => Number.isSafeInteger(n) && n >= 80 && n % 2 === 0));
assert.ok(Number.isSafeInteger(samples) && samples > 0);
const directory = await mkdtemp(join(tmpdir(), 'lody-roost-bench-'));
const dbPath = join(directory, 'history.db');
const seed = new Uint8Array(32).fill(21);
const owner = Identity.fromSeed(seed).owner();
const pageSize = 40;
const results: Record<string, unknown>[] = [];
const trace = (stage: string) => {
  if (process.env.BENCH_TRACE === '1') process.stderr.write(`${stage}\n`);
};
const hash = async (file: string) =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');

// Instrument real API calls; no alternate implementation or fake storage.
const counts = { fullReads: 0, pageReads: 0, physicalPageRows: 0 };
const originalFull = NodeLodyHistory.prototype.readActiveBranch;
const originalPage = NodeLodyHistory.prototype.readActiveBranchPage;
NodeLodyHistory.prototype.readActiveBranch = async function (...args) {
  counts.fullReads += 1;
  return originalFull.apply(this, args);
};
NodeLodyHistory.prototype.readActiveBranchPage = async function (...args) {
  counts.pageReads += 1;
  const result = await originalPage.apply(this, args);
  counts.physicalPageRows += result.messages.length;
  return result;
};
const resetCounts = () =>
  Object.assign(counts, { fullReads: 0, pageReads: 0, physicalPageRows: 0 });

installRoostNodeSessionBackend({
  dbPath,
  seed,
});

function fixture(count: number): SessionHistory[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `turn-${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    timestamp: '2026-10-04T00:00:00.000Z',
    ...(i % 2 === 0
      ? { status: 'handled', read: true }
      : { userTurnId: `turn-${i - 1}`, acpTurnId: `acp-${i}` }),
    finished: i < count - 1,
    items: [{ type: 'text', text: `${i}:` + 'x'.repeat(bodyBytes) }],
    fileDiff: [],
  })) as SessionHistory[];
}

async function seedRoost(sessionId: SessionId, entries: SessionHistory[]) {
  const client = new RoostNativeClient({
    dbPath,
    seed,
    allowedOwners: [owner],
    maxQueuedRequests: 32,
    maxQueuedBytes: 16 * 1024 * 1024,
  });
  try {
    await client.ready;
    const stream = client.stream(`lody-session:${sessionId}`);
    const history = new NodeLodyHistory(stream, owner);
    let head: HistoryIdentity | null = null;
    let parents: { id: Uint8Array; hash: Uint8Array }[] = [];
    for (const [i, entry] of entries.entries()) {
      const identity = { kind: 'message' as const, businessId: entry.id, segmentId: 'primary' };
      const accepted = await history.acceptToView({
        viewId: sessionId,
        expectedRevision: BigInt(i),
        expectedHead: head,
        operationId: `seed-${i}`,
        input: { ...identity, parents, content: fromApplicationJson(entry) },
      });
      head = identity;
      if (i < entries.length - 1) {
        await history.finish(accepted.turnId, 1n);
        const read = await stream.readTurn(accepted.turnId);
        assert.equal(read.kind, 'found');
        assert.ok(read.turn.sealed);
        parents = [{ id: accepted.turnId, hash: read.turn.sealed }];
      }
      if ((i + 1) % 1000 === 0) process.stderr.write(`seed ${sessionId}: ${i + 1}\n`);
    }
    await history.catchUpIndex();
  } finally {
    await client.close();
  }
}

async function sample(
  backendKind: 'loro' | 'roost',
  count: number,
  snapshot: Uint8Array,
  ordinal: number
) {
  const repo = await LoroRepo.create({});
  const sessionId = `bench-${count}` as SessionId;
  const roomId = getSessionRoomId(sessionId);
  const session = new SessionDocument(repo, sessionId, (id) => repo.unloadDoc(id));
  let view: ReturnType<typeof createConversationViewFromReader> | undefined;
  let releaseRange: (() => void) | undefined;
  try {
    resetCounts();
    const start = performance.now();
    if (backendKind === 'loro') {
      const handle = await repo.openPersistedDoc(roomId);
      handle.doc.import(snapshot);
    }
    const imported = performance.now();
    await session.initOffline(undefined, { historyBackend: backendKind });
    const backend = session.getSessionBackend();
    assert.ok(backend);
    const opened = performance.now();
    trace(`${backendKind}: backend opened`);
    view = createConversationViewFromReader(backend.history, {
      sessionId,
      tailKeep: 0,
      scheduleIdle: (task) => {
        const timer = setTimeout(() => task({ timeRemaining: () => 8 }), 0);
        return () => clearTimeout(timer);
      },
    });
    if (view.turnCount !== count) {
      await new Promise<void>((resolveReady) => {
        let unsubscribe: (() => void) | undefined;
        unsubscribe = view?.subscribe((event) => {
          if (event.kind !== 'structure') return;
          unsubscribe?.();
          resolveReady();
        });
      });
    }
    assert.equal(view.turnCount, count);
    const range = view.acquireRange(count - pageSize, count);
    releaseRange = range.release;
    await range.ready;
    assert.equal(view.turn(count - 1)?.id, `turn-${count - 1}`);
    assert.equal(view.turn(0), undefined);
    const readable = performance.now();
    const openReads = { ...counts };
    trace(`${backendKind}: latest window ready`);

    resetCounts();
    const olderStart = performance.now();
    if (backendKind === 'roost') assert.equal(await view.loadOlder?.(), true);
    const older = view.acquireRange(count - 2 * pageSize, count - pageSize);
    await older.ready;
    assert.equal(view.turn(count - 2 * pageSize)?.id, `turn-${count - 2 * pageSize}`);
    const olderMs = performance.now() - olderStart;
    const olderReads = { ...counts };
    older.release();
    trace(`${backendKind}: older window ready`);

    const updates = [];
    resetCounts();
    for (let i = 0; i < 10; i++) {
      const marker = ` [sample-${ordinal}-${i}]`;
      const updated = new Promise<void>((resolveUpdated, rejectUpdated) => {
        let unsubscribe: (() => void) | undefined;
        const deadline = setTimeout(() => {
          unsubscribe?.();
          rejectUpdated(
            new Error(`${backendKind} streaming output was not visible within 30 seconds`)
          );
        }, 30000);
        unsubscribe = view?.subscribe(() => {
          const turn = view?.turn(count - 1);
          if (!JSON.stringify(turn?.items).includes(marker)) return;
          clearTimeout(deadline);
          unsubscribe?.();
          resolveUpdated();
        });
      });
      const updateStart = performance.now();
      await backend.applyAgentBatch({
        targetAssistantEntryId: `turn-${count - 1}`,
        entryBound: true,
        contents: [{ type: 'text', text: marker }],
        operationIds: [`bench-${count}-${ordinal}-${i}`],
      });
      trace(`${backendKind}: update ${i} persisted`);
      await updated;
      trace(`${backendKind}: update ${i} visible`);
      updates.push(performance.now() - updateStart);
    }
    const updateReads = { ...counts };
    let structuralObservation: Record<string, unknown> = {};
    if (structural) {
      resetCounts();
      const directoryStart = performance.now();
      const lease = view.acquireDirectory?.();
      assert.ok(lease);
      try {
        await lease.ready;
      } finally {
        lease.release();
      }
      const fullDirectoryMs = performance.now() - directoryStart;
      const directoryReads = { ...counts };
      assert.equal(view.hasMoreOlder, false);
      assert.equal(view.index(0)?.id, 'turn-0');
      resetCounts();
      const editStart = performance.now();
      const editedId = `edited-${count}-${ordinal}`;
      const edit = await backend.replaceEditableTail({
        expectedUserTurnId: `turn-${count - 2}`,
        expectedForkTurnId: `acp-${count - 3}`,
        replacement: {
          id: editedId,
          role: 'user',
          timestamp: '2026-10-09T00:00:00.000Z',
          status: 'pending',
          read: false,
          finished: false,
          items: [{ type: 'text', text: 'Edited message' }],
          fileDiff: [],
        } as never,
      });
      const editableTailMs = performance.now() - editStart;
      const editReads = { ...counts };
      assert.equal(edit.status, 'accepted');
      assert.equal(await backend.history.count(), count - 1);
      assert.equal((await backend.history.readAt(count - 2)).state, 'ready');
      structuralObservation = { fullDirectoryMs, directoryReads, editableTailMs, editReads };
      trace(
        `${backendKind}: directory ${fullDirectoryMs.toFixed(2)}ms, edit ${editableTailMs.toFixed(2)}ms`
      );
    }
    return {
      ...structuralObservation,
      backend: backendKind,
      count,
      importMs: imported - start,
      backendOpenMs: opened - imported,
      viewMs: readable - opened,
      readableMs: readable - start,
      olderMs,
      updates,
      openReads,
      olderReads,
      updateReads,
    };
  } finally {
    releaseRange?.();
    view?.dispose();
    await session.destroy({ preserveStatus: true });
    await repo.destroy();
  }
}

const summarize = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    min: sorted[0],
    max: sorted.at(-1),
  };
};
try {
  for (const count of sizes) {
    const entries = fixture(count);
    const doc = buildSessionDoc(structuredClone(entries));
    const snapshot = doc.export({ mode: 'snapshot' });
    doc.free();
    await seedRoost(`bench-${count}` as SessionId, entries);
    const storedFixture = join(directory, `fixture-${count}.db`);
    await copyFile(dbPath, storedFixture);
    const observations: Awaited<ReturnType<typeof sample>>[] = [];
    for (let i = 0; i < warmups + samples; i++) {
      const order: ('loro' | 'roost')[] = i % 2 === 0 ? ['loro', 'roost'] : ['roost', 'loro'];
      for (const kind of order) {
        if (kind === 'roost') await copyFile(storedFixture, dbPath);
        const result = await sample(kind, count, snapshot, i);
        if (i >= warmups) observations.push(result);
        process.stderr.write(
          `${count} ${kind} ${i < warmups ? 'warmup' : 'sample'}: open ${result.readableMs.toFixed(2)}ms, older ${result.olderMs.toFixed(2)}ms\n`
        );
      }
    }
    for (const kind of ['loro', 'roost']) {
      const values = observations.filter((row) => row.backend === kind);
      results.push({
        backend: kind,
        count,
        snapshotBytes: snapshot.length,
        readableMs: summarize(values.map((row) => row.readableMs)),
        importMs: summarize(values.map((row) => row.importMs)),
        backendOpenMs: summarize(values.map((row) => row.backendOpenMs)),
        viewMs: summarize(values.map((row) => row.viewMs)),
        olderMs: summarize(values.map((row) => row.olderMs)),
        streamingMs: summarize(values.flatMap((row) => row.updates)),
        ...(structural
          ? {
              fullDirectoryMs: summarize(values.map((row) => Number(row.fullDirectoryMs))),
              editableTailMs: summarize(values.map((row) => Number(row.editableTailMs))),
            }
          : {}),
        observations: values,
      });
    }
    await writeFile(
      output,
      JSON.stringify(
        {
          environment: {
            node: process.version,
            platform: platform(),
            arch: arch(),
            cpu: cpus()[0]?.model,
          },
          samples,
          warmups,
          bodyBytes,
          pageSize,
          structural,
          sourceHashes: {
            nativeLoader: await hash(nativeBinding),
            nativeClient: await hash(fileURLToPath(clientModule)),
            nodeSession: await hash(join(root, 'apps/cli/src/session/roost-node-session.ts')),
            view: await hash(
              join(
                root,
                'packages/components/src/lib/conversation-view/create-conversation-view-from-reader.ts'
              )
            ),
            roostHistory: await hash(
              fileURLToPath(import.meta.resolve('@loro-dev/roost/lody-history'))
            ),
          },
          boundaries: [
            'Fresh backends/views, warm OS page cache. Loro snapshot import included; Roost owner process startup included.',
            'Loro control Repo has no disk storage. Roost history writes use actual SQLite durability; Loro update timings exclude disk flush.',
            'No renderer transport, IndexedDB, React, paint, full search, background facts or offline cache refresh. BENCH_STRUCTURAL=1 separately measures the complete directory and last-user edit after streaming.',
            'Fixed 4 KiB text bodies, linear active ancestry, unsealed streaming tail; no late segments.',
          ],
          results,
        },
        null,
        2
      ) + '\n'
    );
  }
  process.stderr.write(`Results: ${output}\n`);
} finally {
  NodeLodyHistory.prototype.readActiveBranch = originalFull;
  NodeLodyHistory.prototype.readActiveBranchPage = originalPage;
  await rm(directory, { recursive: true, force: true });
}

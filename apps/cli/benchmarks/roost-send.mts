/**
 * Synthetic owner-side send comparison using production SessionDocument backends.
 * Run from apps/cli with the pinned workspace dependencies:
 * TSX_TSCONFIG_PATH=tsconfig.json node --import ./node_modules/tsx/dist/loader.mjs benchmarks/roost-send.mts
 * Roost includes native SQLite/signing; Loro uses live in-memory history commits.
 * Transport, renderer IndexedDB, dispatch, React and paint are excluded.
 * Measurements are observations, not timing assertions or delivery guarantees.
 */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, platform, arch } from 'node:os';
import { performance } from 'node:perf_hooks';
import { LoroRepo } from 'loro-repo';
import { getSessionRoomId, type SessionHistoryInput, type SessionId } from '@lody/shared';
import type { SessionInputAcceptanceResult, SessionTurn } from '@lody/shared/session-data';
import { SessionDocument } from '../src/lib/loro/doc';
import { installRoostNodeSessionBackend } from '../src/session/roost-node-session';
import type { SessionBackend } from '../src/session/session-backend';

const samples = Number(process.env.BENCH_SAMPLES ?? 9);
const warmups = Number(process.env.BENCH_WARMUPS ?? 2);
const combinedDispatch = process.env.BENCH_DISPATCH === '1';
assert.ok(Number.isSafeInteger(samples) && samples > 0);
assert.ok(Number.isSafeInteger(warmups) && warmups >= 0);
const directory = await mkdtemp(join(tmpdir(), 'lody-roost-send-'));
const output = process.env.BENCH_OUTPUT ?? join(directory, 'results.json');
installRoostNodeSessionBackend({
  dbPath: join(directory, 'history.db'),
  seed: new Uint8Array(32).fill(29),
});

const observeSeen = (backend: SessionBackend, id: string, start: number) => {
  let busy = false;
  let dirty = false;
  let settled = false;
  let resolve!: (milliseconds: number) => void;
  let reject!: (error: unknown) => void;
  const result = new Promise<number>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const check = async () => {
    dirty = true;
    if (busy || settled) return;
    busy = true;
    try {
      do {
        dirty = false;
        const read = await backend.readTurn(id);
        if (read.state === 'ready' && read.turn.status === 'seen') {
          settled = true;
          resolve(performance.now() - start);
        }
      } while (dirty && !settled);
    } catch (error) {
      settled = true;
      reject(error);
    } finally {
      busy = false;
    }
  };
  const unsubscribe = backend.subscribeHistory(() => {
    void check();
  });
  void check();
  const timeout = setTimeout(
    () => reject(new Error('Synthetic owner did not mark input seen')),
    30_000
  );
  return {
    result,
    close: () => {
      settled = true;
      clearTimeout(timeout);
      unsubscribe();
    },
  };
};

type Sample = {
  backend: 'loro' | 'roost';
  round: number;
  kind: 'first' | 'follow-up';
  acceptMs: number;
  seenMs: number;
  initializeMs: number;
};
const measurements: Sample[] = [];
async function measure(backendKind: 'loro' | 'roost', round: number) {
  const repo = await LoroRepo.create({});
  const sessionId = `synthetic-send-${backendKind}-${round}` as SessionId;
  await repo.upsertDocMeta(getSessionRoomId(sessionId), {
    id: sessionId,
    historyBackend: backendKind,
    machineId: 'synthetic-owner',
    userId: 'synthetic-sender',
  });
  const session = new SessionDocument(repo, sessionId, (id) => repo.unloadDoc(id));
  try {
    const opening = performance.now();
    await session.initOffline(undefined, { historyBackend: backendKind });
    const initializeMs = performance.now() - opening;
    const backend = session.getSessionBackend();
    assert.ok(backend);
    for (let ordinal = 0; ordinal < 4; ordinal += 1) {
      const entry: SessionHistoryInput = {
        id: `${sessionId}-input-${ordinal}`,
        role: 'user',
        userId: 'synthetic-sender',
        timestamp: '2026-10-14T00:00:00.000Z',
        status: 'pending',
        read: false,
        finished: true,
        fileDiff: [],
        items: [{ type: 'text', text: 'Synthetic send comparison. '.repeat(8) }],
        inputConfig: {
          cliType: 'builtin',
          agentType: 'codex',
          inputBlocks: [{ type: 'text', text: 'Synthetic send comparison. '.repeat(8) }],
        },
      };
      const start = performance.now();
      const seen = observeSeen(backend, entry.id, start);
      try {
        if (backendKind === 'roost') {
          assert.ok(backend.inputAcceptance);
          const accept:
            | ((entry: SessionTurn) => Promise<SessionInputAcceptanceResult>)
            | undefined = combinedDispatch
            ? backend.inputAcceptance.acceptAndDispatch
            : backend.inputAcceptance.accept;
          assert.ok(accept);
          const receipt: SessionInputAcceptanceResult = await accept(
            entry as unknown as SessionTurn
          );
          assert.equal(receipt.status, 'accepted');
        } else await backend.appendUserTurn(entry);
        const acceptMs = performance.now() - start;
        const seenMs = await seen.result;
        if (combinedDispatch)
          assert.equal((await session.getMetaState())?.latestUserMsgId, entry.id);
        if (round >= warmups)
          measurements.push({
            backend: backendKind,
            round,
            kind: ordinal === 0 ? 'first' : 'follow-up',
            acceptMs,
            seenMs,
            initializeMs,
          });
      } finally {
        seen.close();
      }
    }
  } finally {
    await session.destroy({ preserveStatus: true });
    await repo.destroy();
  }
}
for (let round = 0; round < samples + warmups; round += 1) {
  for (const backend of round % 2 ? (['roost', 'loro'] as const) : (['loro', 'roost'] as const))
    await measure(backend, round);
}
const summarize = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    samples: sorted.length,
  };
};
const summary = ['loro', 'roost'].flatMap((backend) =>
  ['first', 'follow-up'].map((kind) => {
    const rows = measurements.filter((row) => row.backend === backend && row.kind === kind);
    return {
      backend,
      kind,
      acceptMs: summarize(rows.map((row) => row.acceptMs)),
      seenMs: summarize(rows.map((row) => row.seenMs)),
      initializeMs: summarize(rows.map((row) => row.initializeMs)),
    };
  })
);
const report = {
  platform: platform(),
  architecture: arch(),
  node: process.version,
  samples,
  warmups,
  combinedDispatch,
  limitations: [
    'No network or renderer: these are owner-local timings.',
    'Roost commits durable SQLite history; Loro uses an in-memory Repo and excludes persistence.',
    'First send is measured after backend initialization; initialization is reported separately.',
    'BENCH_DISPATCH=1 includes owner activation; no dispatcher or Agent execution is instantiated.',
  ],
  summary,
  measurements,
};
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ output, summary }, null, 2));

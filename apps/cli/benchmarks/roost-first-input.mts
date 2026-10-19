/**
 * Local cold-open/first-input comparison over identical synthetic snapshots.
 * Prepare once, then run each source revision with the same BENCH_DIR:
 * TSX_TSCONFIG_PATH=tsconfig.json node --experimental-wasm-modules --import ./node_modules/tsx/dist/loader.mjs benchmarks/roost-first-input.mts
 * BENCH_PHASE=prepare writes fixtures; measure is the default. BENCH_VARIANT is
 * a report label, never an alternate implementation. No network or ACP runs.
 * Typecheck: pnpm exec tsgo --noEmit -p benchmarks/tsconfig.first-input.json
 * Timing is reported, never asserted; Roost includes SQLite durability while
 * the Loro control uses an in-memory Repo restored from a snapshot.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { arch, cpus, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { NodeLodyHistory } from '@loro-dev/roost/lody-history';
import { getSessionRoomId, type SessionHistoryInput, type SessionId } from '@lody/shared';
import {
  hashHistoryEntryForVersion,
  hashText,
  type SessionInputAcceptance,
  type SessionTurn,
} from '@lody/shared/session-data';
import { WorkspaceRepoLegacy } from '@lody/shared/workspace-data/repo-legacy';
import { SessionDocument } from '../src/lib/loro/doc';
import { installRoostNodeSessionBackend } from '../src/session/roost-node-session';
import type { SessionBackend } from '../src/session/session-backend';

type BackendKind = 'loro' | 'roost';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const directory = process.env.BENCH_DIR;
assert.ok(
  directory !== undefined && directory.length > 0,
  'Set BENCH_DIR to a dedicated temporary directory'
);
const sizes = (process.env.BENCH_SIZES ?? '0,100,1000').split(',').map(Number);
const samples = Number(process.env.BENCH_SAMPLES ?? 5);
const warmups = Number(process.env.BENCH_WARMUPS ?? 1);
const bodyBytes = Number(process.env.BENCH_BODY_BYTES ?? 4096);
assert.ok(sizes.every((size) => Number.isSafeInteger(size) && size >= 0 && size % 2 === 0));
assert.ok(Number.isSafeInteger(samples) && samples > 0);
assert.ok(Number.isSafeInteger(warmups) && warmups >= 0);
assert.ok(Number.isSafeInteger(bodyBytes) && bodyBytes > 0);
await mkdir(directory, { recursive: true });
const dbPath = join(directory, 'active.db');
installRoostNodeSessionBackend({ dbPath, seed: new Uint8Array(32).fill(47) });
const sessionIdFor = (size: number) => `synthetic-first-input-${size}` as SessionId;
const clearDatabase = async () => {
  for (const suffix of ['', '-wal', '-shm']) await rm(`${dbPath}${suffix}`, { force: true });
};
const oldHistory = (size: number): Array<SessionHistoryInput & SessionTurn> =>
  Array.from({ length: size }, (_, index) => ({
    id: `old-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    ...(index % 2 === 0
      ? { userId: 'synthetic-sender', status: 'handled' as const, read: true }
      : { userTurnId: `old-${index - 1}` }),
    timestamp: '2026-10-19T00:00:00.000Z',
    finished: true,
    items: [{ type: 'text', text: `${index}:` + 'x'.repeat(bodyBytes) }],
    fileDiff: [],
  }));

async function open(kind: BackendKind, size: number) {
  const repo = await WorkspaceRepoLegacy.create({});
  const sessionId = sessionIdFor(size);
  const roomId = getSessionRoomId(sessionId);
  await repo.upsertDocMeta(roomId, {
    id: sessionId,
    historyBackend: kind,
    machineId: 'synthetic-owner',
    userId: 'synthetic-sender',
    ...(size > 0 ? { latestUserMsgId: `old-${size - 2}` } : {}),
  });
  const session = new SessionDocument(repo, sessionId, (id) => repo.unloadDoc(id));
  return {
    repo,
    session,
    close: async () => {
      try {
        await session.destroy({ preserveStatus: true });
      } finally {
        await repo.destroy();
      }
    },
  };
}

if (process.env.BENCH_PHASE === 'prepare') {
  for (const size of sizes) {
    const history = oldHistory(size);
    const hashes = history.map((turn) => hashHistoryEntryForVersion(turn, 2));
    for (const kind of ['roost', 'loro'] as const) {
      if (kind === 'roost') await clearDatabase();
      const fixture = await open(kind, size);
      try {
        await fixture.session.initOffline(undefined, { historyBackend: kind });
        const backend: SessionBackend | undefined = fixture.session.getSessionBackend();
        assert.ok(backend);
        if (size > 0)
          assert.equal(
            (
              await backend.applyHistoryImport({
                mode: 'initialize',
                replay: {
                  history,
                  turnHashes: hashes,
                  replayDigest: hashText(hashes.join('\n')),
                  hashVersion: 2,
                  droppedNotifications: 0,
                },
              })
            ).status,
            'accepted'
          );
        assert.equal(await backend.history.count(), size);
        if (kind === 'loro') {
          const handle = await fixture.repo.openPersistedDoc(getSessionRoomId(sessionIdFor(size)));
          await writeFile(
            join(directory, `seed-${size}.loro`),
            handle.doc.export({ mode: 'snapshot' })
          );
        }
      } finally {
        await fixture.close();
      }
      if (kind === 'roost') await copyFile(dbPath, join(directory, `seed-${size}.db`));
    }
    process.stderr.write(`Prepared ${size} synthetic history rows\n`);
  }
  await writeFile(join(directory, 'fixture.json'), JSON.stringify({ sizes, bodyBytes }));
} else {
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'fixture.json'), 'utf8')), {
    sizes,
    bodyBytes,
  });
  const counts = { pages: 0, olderPages: 0, pageRows: 0, olderRows: 0, fullReads: 0 };
  const resetCounts = () =>
    Object.assign(counts, { pages: 0, olderPages: 0, pageRows: 0, olderRows: 0, fullReads: 0 });
  const originalPage = NodeLodyHistory.prototype.readActiveBranchPage;
  NodeLodyHistory.prototype.readActiveBranchPage = async function (...args) {
    const page = await originalPage.apply(this, args);
    counts.pages += 1;
    counts.pageRows += page.messages.length;
    if (args[1]?.before) {
      counts.olderPages += 1;
      counts.olderRows += page.messages.length;
    }
    return page;
  };
  const originalFull = NodeLodyHistory.prototype.readActiveBranch;
  NodeLodyHistory.prototype.readActiveBranch = async function (...args) {
    counts.fullReads += 1;
    return originalFull.apply(this, args);
  };
  const results: Record<string, unknown>[] = [];
  for (const size of sizes) {
    for (let round = -warmups; round < samples; round += 1) {
      const order: readonly BackendKind[] = round % 2 === 0 ? ['loro', 'roost'] : ['roost', 'loro'];
      for (const kind of order) {
        if (kind === 'roost') {
          await clearDatabase();
          await copyFile(join(directory, `seed-${size}.db`), dbPath);
        }
        const fixture = await open(kind, size);
        try {
          resetCounts();
          const started = performance.now();
          if (kind === 'loro') {
            const handle = await fixture.repo.openPersistedDoc(
              getSessionRoomId(sessionIdFor(size))
            );
            handle.doc.import(await readFile(join(directory, `seed-${size}.loro`)));
          }
          await fixture.session.initOffline(undefined, { historyBackend: kind });
          const initializedAt = performance.now();
          const initializeMs = initializedAt - started;
          const initializeReads = { ...counts };
          const backend: SessionBackend | undefined = fixture.session.getSessionBackend();
          assert.ok(backend);
          for (const inputIndex of [0, 1]) {
            const entry: SessionHistoryInput & SessionTurn = {
              id: `synthetic-input-${inputIndex}`,
              role: 'user',
              userId: 'synthetic-sender',
              timestamp: '2026-10-19T00:01:00.000Z',
              status: 'pending',
              read: false,
              finished: true,
              items: [{ type: 'text', text: 'Synthetic local acceptance comparison.' }],
              fileDiff: [],
            };
            resetCounts();
            const acceptingAt = performance.now();
            if (kind === 'roost') {
              const accept: SessionInputAcceptance['acceptAndDispatch'] =
                backend.inputAcceptance?.acceptAndDispatch;
              assert.ok(accept);
              assert.deepEqual(await accept(entry), {
                status: 'accepted',
                turnId: entry.id,
                active: true,
              });
            } else await backend.appendUserTurn(entry);
            const acceptedAt = performance.now();
            const acceptanceReads = { ...counts };
            assert.equal((await fixture.session.getMetaState())?.latestUserMsgId, entry.id);
            assert.equal((await backend.history.readTurn(entry.id)).state, 'ready');
            if (round >= 0)
              results.push({
                backend: kind,
                historyRows: size,
                round,
                input: inputIndex === 0 ? 'first' : 'follow-up',
                initializeMs,
                acceptMs: acceptedAt - acceptingAt,
                ...(inputIndex === 0 ? { coldTotalMs: acceptedAt - started } : {}),
                initializeReads,
                acceptanceReads,
              });
          }
        } finally {
          await fixture.close();
        }
      }
    }
    process.stderr.write(`Measured ${size} rows (${samples} samples per backend)\n`);
  }
  const sourceHashes = Object.fromEntries(
    await Promise.all(
      [
        'packages/shared/src/session-data/read.ts',
        'apps/cli/src/session/roost-session-backend.ts',
      ].map(
        async (path) =>
          [
            path,
            createHash('sha256')
              .update(await readFile(join(root, path)))
              .digest('hex'),
          ] as const
      )
    )
  );
  const output = process.env.BENCH_OUTPUT ?? join(directory, 'results.json');
  await writeFile(
    output,
    JSON.stringify(
      {
        variant: process.env.BENCH_VARIANT ?? 'current',
        sourceHashes,
        environment: {
          node: process.version,
          platform: platform(),
          arch: arch(),
          cpu: cpus()[0]?.model,
        },
        samples,
        warmups,
        sizes,
        bodyBytes,
        limitations: [
          'No renderer, request/response transport, remote metadata, ACP or Agent execution.',
          'Roost includes SQLite/signing; Loro restores a snapshot into an in-memory Repo, without persistence.',
          'Every trial reopens the session and native Worker; OS file caches are warm.',
          'Fixture copying and local metadata setup are excluded; initialization includes Loro snapshot loading.',
          'Timings are observations, never pass/fail thresholds or remote-latency predictions.',
        ],
        results,
      },
      null,
      2
    ) + '\n'
  );
  process.stdout.write(`${output}\n`);
}

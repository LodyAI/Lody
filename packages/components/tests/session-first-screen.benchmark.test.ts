import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LoroDoc } from 'loro-crdt';
import { LoroRepo } from 'loro-repo';
import { describe, it } from 'vitest';
import { createHistoryWriter, type SessionHistory, type SessionId } from '@lody/shared';
import { connectNativeRepo } from '../../shared/src/node/native-repo';
import {
  createDocRoom,
  createNativeDocs,
  createNativeRemoteHistoryPort,
} from '../../shared/src/node/native-docs';
import {
  createRemoteControlState,
  createRemoteLoroHistoryReader,
  shareObservation,
} from '@lody/shared/session-data';
import { sessionDocSchema } from '@lody/shared';
import { createConversationViewFromReader } from '../src/lib/conversation-view/create-conversation-view-from-reader';
import { createConversationSession } from '../src/lib/conversation-view';
import type { IdleScheduler } from '../src/lib/conversation-view/create-conversation-view-from-reader';

// Opt-in: LODY_SESSION_FIRST_SCREEN_BENCH=<turns>[,<turns>...]. The renderer's
// real first screen: load the document, compose the conversation session, wait
// until the view is ready (its retained tail hydrated), then hold the latest 50.
const sizes = (process.env.LODY_SESSION_FIRST_SCREEN_BENCH ?? '')
  .split(',')
  .map(Number)
  .filter((n) => n > 0);

// LODY_SESSION_FIRST_SCREEN_PATHS=legacy,native,remote selects paths (default all).
const paths = new Set(
  (process.env.LODY_SESSION_FIRST_SCREEN_PATHS ?? 'legacy,native,remote').split(',')
);
const sessionId = 'bench' as SessionId;
const docId = 'session-bench';
const text = (length: number, seed: number) =>
  `turn ${seed} `.padEnd(length, 'lorem ipsum dolor sit amet ');
const turn = (index: number): SessionHistory =>
  (index % 2 === 0
    ? {
        id: `turn-${index}`,
        role: 'user',
        timestamp: '2026-01-01T00:00:00Z',
        items: [{ type: 'text', text: text(200, index) }],
        fileDiff: [],
      }
    : {
        id: `turn-${index}`,
        role: 'assistant',
        timestamp: '2026-01-01T00:00:00Z',
        items: [
          { type: 'text', text: text(1200, index) },
          { type: 'text', text: text(300, index + 1) },
        ],
        fileDiff: [],
      }) as SessionHistory;
const ms = (start: number) => +(performance.now() - start).toFixed(1);
const hostScript = fileURLToPath(
  new URL('../../shared/tests/fixtures/native-repo-host.mjs', import.meta.url)
);

/** An otherwise idle renderer: each idle pass runs on the next turn of the loop. */
const idleSoon: IdleScheduler = (task) => {
  const handle = setImmediate(() => task({ timeRemaining: () => 50 }));
  return () => clearImmediate(handle);
};

/** View ready (tail hydrated) plus the latest 50 hydrated, over an already loaded document. */
async function firstScreen(doc: LoroDoc) {
  let start = performance.now();
  const session = createConversationSession(doc, { sessionId, scheduleIdle: idleSoon });
  await session.history.ready;
  const viewMs = ms(start);
  start = performance.now();
  const count = session.history.turnCount;
  const range = session.history.acquireRange(Math.max(0, count - 50), count);
  await range.ready;
  const last50Ms = ms(start);
  range.release();
  session.dispose();
  return { viewMs, last50Ms };
}

async function legacyPath(snapshot: Uint8Array) {
  const start = performance.now();
  const doc = new LoroDoc();
  doc.import(snapshot);
  const loadMs = ms(start);
  const screen = await firstScreen(doc);
  doc.free();
  return { loadMs, ...screen, totalMs: +(loadMs + screen.viewMs + screen.last50Ms).toFixed(1) };
}

async function nativePath(turns: number, snapshot: Uint8Array) {
  const dataDir = await mkdtemp(join(tmpdir(), `lody-first-screen-${turns}-`));
  const ns = 'bench';
  const room = { kind: 'loro_doc' as const, id: docId };
  const connection = await connectNativeRepo({
    dataDir,
    launcher: () => ({ command: process.execPath, args: [hostScript] }),
  });
  const { pid } = JSON.parse(await readFile(join(dataDir, 'engine.json'), 'utf8')) as {
    pid: number;
  };
  try {
    await createDocRoom(connection.client, ns, docId);
    await connection.client.importRoomState(ns, room, { snapshot });
    const owns = (id: string) => id === docId;
    const repo = await LoroRepo.create({
      externalDocs: createNativeDocs(connection.client, ns, owns),
    });
    const open = async () => {
      const start = performance.now();
      const { doc } = await repo.openPersistedDoc(docId);
      const loadMs = ms(start);
      const screen = await firstScreen(doc);
      return {
        loadMs,
        ...screen,
        totalMs: +(loadMs + screen.viewMs + screen.last50Ms).toFixed(1),
      };
    };
    const cold = await open();
    await repo.unloadDoc(docId);
    const reopen = await open();
    await repo.destroy();
    return { cold, reopen };
  } finally {
    await connection.close();
    process.kill(pid, 'SIGTERM');
    await rm(dataDir, { recursive: true, force: true });
  }
}

const mb = (bytes: number) => +(bytes / 1024 / 1024).toFixed(1);
const rssOf = async (pid: number) =>
  Number(/VmRSS:\s+(\d+)/.exec(await readFile(`/proc/${pid}/status`, 'utf8'))?.[1] ?? 0) * 1024;

/**
 * No local replica: the view reads directory pages and turns from the engine.
 * `cold` follows a host restart, so the engine loads the room from disk.
 */
async function remotePath(turns: number, snapshot: Uint8Array) {
  const dataDir = await mkdtemp(join(tmpdir(), `lody-first-screen-remote-${turns}-`));
  const ns = 'bench';
  const room = { kind: 'loro_doc' as const, id: docId };
  const launcher = () => ({ command: process.execPath, args: [hostScript] });
  const pidOf = async () =>
    (JSON.parse(await readFile(join(dataDir, 'engine.json'), 'utf8')) as { pid: number }).pid;
  let connection = await connectNativeRepo({ dataDir, launcher });
  await createDocRoom(connection.client, ns, docId);
  await connection.client.importRoomState(ns, room, { snapshot });
  await connection.close();
  const first = await pidOf();
  process.kill(first, 'SIGTERM');
  while (
    (() => {
      try {
        process.kill(first, 0);
        return true;
      } catch {
        return false;
      }
    })()
  )
    await new Promise((resolve) => setImmediate(resolve));
  connection = await connectNativeRepo({ dataDir, launcher });
  const pid = await pidOf();
  try {
    const screen = async () => {
      globalThis.gc?.();
      const rssBefore = process.memoryUsage().rss;
      const hostBefore = await rssOf(pid);
      let start = performance.now();
      // The renderer's remote store: control roots as JSON plus the paged history view.
      const port = shareObservation(createNativeRemoteHistoryPort(connection.client, ns, docId));
      const control = createRemoteControlState(
        port,
        Object.keys(sessionDocSchema.definition).filter((root) => root !== 'history'),
        {}
      );
      const reader = createRemoteLoroHistoryReader(port);
      const view = createConversationViewFromReader(reader, { sessionId, scheduleIdle: idleSoon });
      await Promise.all([view.ready, control.ready]);
      const viewMs = ms(start);
      start = performance.now();
      const count = view.turnCount;
      const range = view.acquireRange(Math.max(0, count - 50), count);
      await range.ready;
      const last50Ms = ms(start);
      const result = {
        viewMs,
        last50Ms,
        totalMs: +(viewMs + last50Ms).toFixed(1),
        rendererRssDeltaMb: mb(process.memoryUsage().rss - rssBefore),
        hostRssDeltaMb: mb((await rssOf(pid)) - hostBefore),
      };
      range.release();
      view.dispose();
      control.close();
      return result;
    };
    const cold = await screen();
    const warm = await screen();
    return { cold, warm };
  } finally {
    await connection.close();
    process.kill(pid, 'SIGTERM');
    await rm(dataDir, { recursive: true, force: true });
  }
}

describe.skipIf(sizes.length === 0)('Session first screen', () => {
  it('measures the legacy and native first screens', async () => {
    const results = [];
    for (const turns of sizes) {
      const source = new LoroDoc();
      const writer = createHistoryWriter(source);
      for (let i = 0; i < turns; i++) writer.append(turn(i));
      const snapshot = source.export({ mode: 'snapshot' });
      source.free();
      results.push({
        turns,
        snapshotMb: +(snapshot.byteLength / 1024 / 1024).toFixed(1),
        ...(paths.has('legacy') ? { legacy: await legacyPath(snapshot) } : {}),
        ...(paths.has('native') ? { native: await nativePath(turns, snapshot) } : {}),
        ...(paths.has('remote') ? { remote: await remotePath(turns, snapshot) } : {}),
      });
    }
    const out = process.env.LODY_SESSION_FIRST_SCREEN_BENCH_OUT;
    if (out) await writeFile(out, JSON.stringify(results, null, 2));
    else console.log(JSON.stringify(results, null, 2));
  }, 3_600_000);
});

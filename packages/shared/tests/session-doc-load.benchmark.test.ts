import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectEngine } from '@loro-dev/loro-repo-client/node';
import { LoroRepo } from 'loro-repo';
import { connectNativeRepo } from '../src/node/native-repo';
import { createNativeDocs, createNativeRemoteHistoryPort } from '../src/node/native-docs';
import { describe, it } from 'vitest';
import { LoroDoc } from 'loro-crdt';
import { createHistoryWriter } from '../src/history-writer';
import { createLoroSessionData } from '../src/session-data/loro';
import {
  createRemoteLoroHistoryReader,
  readRemoteHistoryTranscript,
} from '../src/session-data/remote-loro';
import { selectTranscriptHistoryPositions } from '../src/session-data/history-selection';
import type { SessionHistory, SessionId } from '../src';

// Opt-in: LODY_SESSION_LOAD_BENCH=<turns>[,<turns>...]. Measures the
// whole-document first-screen path with the real HistoryWriter and reader, in
// process and through the native host (open, last 50, append-to-visible).
const sizes = (process.env.LODY_SESSION_LOAD_BENCH ?? '')
  .split(',')
  .map(Number)
  .filter((n) => n > 0);

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
const mb = (bytes: number) => +(bytes / 1024 / 1024).toFixed(1);

const hostScript = fileURLToPath(new URL('./fixtures/native-repo-host.mjs', import.meta.url));
const rssOf = async (pid: number) =>
  Number(/VmRSS:\s+(\d+)/.exec(await readFile(`/proc/${pid}/status`, 'utf8'))?.[1] ?? 0) * 1024;
const percentiles = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number) =>
    +sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!.toFixed(2);
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99) };
};

/** The same document through the native host: open, first screen, append-to-visible. */
async function nativePath(turns: number, snapshot: Uint8Array) {
  const dataDir = await mkdtemp(join(tmpdir(), `lody-native-session-${turns}-`));
  const ns = 'bench';
  const docId = 'session-bench';
  const connection = await connectNativeRepo({
    dataDir,
    launcher: () => ({ command: process.execPath, args: [hostScript] }),
  });
  const peer = await connectEngine(dataDir, { queueWhileReconnecting: false });
  const pid = (JSON.parse(await readFile(join(dataDir, 'engine.json'), 'utf8')) as { pid: number })
    .pid;
  try {
    await connection.client.createRoom(ns, { kind: 'loro_doc', id: docId }, 'plaintext');
    await connection.client.importRoomState(ns, { kind: 'loro_doc', id: docId }, { snapshot });
    const owned = (id: string) => id === docId;
    const daemon = await LoroRepo.create({
      externalDocs: createNativeDocs(connection.client, ns, owned),
    });
    const daemonDoc = (await daemon.openPersistedDoc(docId)).doc;
    const writer = createLoroSessionData({ sessionId: 'bench' as SessionId, doc: daemonDoc });
    globalThis.gc?.();
    const rssBefore = process.memoryUsage().rss;
    const hostBefore = await rssOf(pid);

    let start = performance.now();
    const raw = await peer.exportLoroRaw(ns, { kind: 'loro_doc', id: docId });
    const rawExportMs = ms(start);
    start = performance.now();
    LoroDoc.fromSnapshot(raw.bytes).free();
    const fromSnapshotMs = ms(start);
    start = performance.now();
    const renderer = await LoroRepo.create({ externalDocs: createNativeDocs(peer, ns, owned) });
    const doc = (await renderer.openPersistedDoc(docId)).doc;
    const openMs = ms(start);
    const data = createLoroSessionData({ sessionId: 'bench' as SessionId, doc });
    start = performance.now();
    data.history.readRange(turns - 50, turns);
    const last50Ms = ms(start);
    start = performance.now();
    const observation = data.history.observe(() => {});
    await observation.initial;
    const directoryMs = ms(start);
    const rendererRssMb = mb(process.memoryUsage().rss - rssBefore);
    const hostRssMb = mb((await rssOf(pid)) - hostBefore);

    const visible: number[] = [];
    for (let i = 0; i < 60; i++) {
      const length = doc.getList('history').length;
      const seen = new Promise<void>((resolve) => {
        const stop = doc.subscribe(() => {
          if (doc.getList('history').length > length) {
            stop();
            resolve();
          }
        });
      });
      start = performance.now();
      await writer.commands.appendTurn(turn(turns + i));
      await daemon.persistDocNow(docId, daemonDoc);
      await seen;
      if (i >= 10) visible.push(performance.now() - start);
    }
    observation.unsubscribe();
    await renderer.destroy();
    await daemon.destroy();
    return {
      nativeRawExportMs: rawExportMs,
      nativeFromSnapshotMs: fromSnapshotMs,
      nativeOpenMs: openMs,
      nativeLast50Ms: last50Ms,
      nativeFirstScreenWithoutDirectoryMs: +(openMs + last50Ms).toFixed(1),
      nativeDirectoryMs: directoryMs,
      appendVisible: percentiles(visible),
      rendererRssDeltaMb: rendererRssMb,
      hostRssDeltaMb: hostRssMb,
    };
  } finally {
    await peer.close();
    await connection.close();
    process.kill(pid, 'SIGTERM');
    while (
      (() => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      })()
    )
      await new Promise((resolve) => setImmediate(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
}

describe.skipIf(sizes.length === 0)('Session document first-screen load', () => {
  it('measures import, directory, last-50 read and append', async () => {
    const results = [];
    for (const turns of sizes) {
      const source = new LoroDoc();
      const writer = createHistoryWriter(source);
      for (let i = 0; i < turns; i++) writer.append(turn(i));
      const snapshot = source.export({ mode: 'snapshot' });
      source.free();
      globalThis.gc?.();
      const rssBefore = process.memoryUsage().rss;

      let start = performance.now();
      const doc = new LoroDoc();
      doc.import(snapshot);
      const importMs = ms(start);

      const data = createLoroSessionData({ sessionId: 'bench' as SessionId, doc });
      start = performance.now();
      const observation = data.history.observe(() => {});
      await observation.initial;
      const directoryMs = ms(start);

      start = performance.now();
      data.history.readRange(turns - 50, turns);
      const last50Ms = ms(start);
      const rssOpen = process.memoryUsage().rss;

      const appendSamples: number[] = [];
      for (let i = 0; i < 50; i++) {
        start = performance.now();
        await data.commands.appendTurn(turn(turns + i));
        appendSamples.push(performance.now() - start);
      }
      appendSamples.sort((a, b) => a - b);
      observation.unsubscribe();
      results.push({
        turns,
        snapshotMb: mb(snapshot.byteLength),
        importMs,
        directoryMs,
        last50Ms,
        firstScreenMs: +(importMs + directoryMs + last50Ms).toFixed(1),
        appendP50Ms: +appendSamples[25]!.toFixed(2),
        appendP95Ms: +appendSamples[47]!.toFixed(2),
        rssOpenDeltaMb: mb(rssOpen - rssBefore),
        ...(await nativePath(turns, snapshot)),
      });
      doc.free();
    }
    const out = process.env.LODY_SESSION_LOAD_BENCH_OUT;
    if (out) await writeFile(out, JSON.stringify(results, null, 2));
  }, 3_600_000);
});

// Opt-in: LODY_DAEMON_IDLE_BENCH=<sessions>x<turns>. A daemon answering list,
// status and latest-turn reads for idle Sessions: retained replicas (the
// pre-slice behaviour, cached for the GC idle window) against engine reads.
const idleBench = /^(\d+)x(\d+)$/.exec(process.env.LODY_DAEMON_IDLE_BENCH ?? '');

describe.skipIf(!idleBench)('Daemon reads of idle Sessions', () => {
  it('measures memory and list/status/latest-turn latency', async () => {
    const sessions = Number(idleBench![1]);
    const turns = Number(idleBench![2]);
    const source = new LoroDoc();
    const writer = createHistoryWriter(source);
    for (let i = 0; i < turns; i++) writer.append(turn(i));
    const snapshot = source.export({ mode: 'snapshot' });
    source.free();
    const dataDir = await mkdtemp(join(tmpdir(), 'lody-daemon-idle-'));
    const ns = 'bench';
    const ids = Array.from({ length: sessions }, (_, i) => `session-idle-${i}`);
    const launcher = () => ({ command: process.execPath, args: [hostScript] });
    const hostPid = async () =>
      (JSON.parse(await readFile(join(dataDir, 'engine.json'), 'utf8')) as { pid: number }).pid;
    const stopHost = async (pid: number) => {
      process.kill(pid, 'SIGTERM');
      for (;;) {
        try {
          process.kill(pid, 0);
        } catch {
          return;
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    };
    // Seed the rooms, then restart the host so the first reads are cold.
    let connection = await connectNativeRepo({ dataDir, launcher });
    for (const id of ids) {
      await connection.client.createRoom(ns, { kind: 'loro_doc', id }, 'plaintext');
      await connection.client.importRoomState(ns, { kind: 'loro_doc', id }, { snapshot });
    }
    await connection.close();
    await stopHost(await hostPid());

    let start = performance.now();
    connection = await connectNativeRepo({ dataDir, launcher });
    const hostLaunchMs = ms(start);
    const pid = await hostPid();
    const { client } = connection;
    const results: Record<string, unknown> = {
      sessions,
      turns,
      snapshotMb: mb(snapshot.byteLength),
      hostLaunchMs,
    };
    try {
      /** One status snapshot (count, tail directory, queue) and the latest turn's body. */
      const remoteRead = async (id: string) => {
        const port = createNativeRemoteHistoryPort(client, ns, id);
        const history = createRemoteLoroHistoryReader(port);
        let at = performance.now();
        const total = await history.count();
        const [tail] = await Promise.all([
          history.readDirectory(Math.max(0, total - 128), total),
          port.readPath(['mq']),
        ]);
        const statusMs = ms(at);
        at = performance.now();
        const page = await history.readLatestDirectoryPage!(50);
        const listPageMs = ms(at);
        at = performance.now();
        await history.readTurn(tail.at(-1)!.turnId);
        const latestTurnMs = ms(at);
        at = performance.now();
        await readRemoteHistoryTranscript(port, { limit: 50 });
        const transcriptMs = ms(at);
        return { statusMs, listPageMs, latestTurnMs, transcriptMs, rows: page.rows.length };
      };
      globalThis.gc?.();
      let rssBefore = process.memoryUsage().rss;
      let hostBefore = await rssOf(pid);
      const remoteCold = [];
      for (const id of ids) remoteCold.push(await remoteRead(id));
      const remoteWarm = [];
      for (const id of ids) remoteWarm.push(await remoteRead(id));
      globalThis.gc?.();
      results.remote = {
        cold: remoteCold,
        warm: remoteWarm,
        daemonRssDeltaMb: mb(process.memoryUsage().rss - rssBefore),
        hostRssDeltaMb: mb((await rssOf(pid)) - hostBefore),
      };

      // Pre-slice: each read opens a replica that the daemon cache retains.
      rssBefore = process.memoryUsage().rss;
      hostBefore = await rssOf(pid);
      const repo = await LoroRepo.create({
        externalDocs: createNativeDocs(client, ns, (id) => ids.includes(id)),
      });
      const replicaReads = [];
      const retained = [];
      for (const id of ids) {
        let at = performance.now();
        const { doc } = await repo.openPersistedDoc(id);
        const data = createLoroSessionData({ sessionId: id as SessionId, doc });
        const openMs = ms(at);
        at = performance.now();
        const directory = data.history.readDirectory(0, Number.MAX_SAFE_INTEGER);
        doc.getList('mq').toJSON();
        const statusMs = ms(at);
        at = performance.now();
        data.history.readTurn(directory.at(-1)!.turnId);
        const latestTurnMs = ms(at);
        at = performance.now();
        const visible = selectTranscriptHistoryPositions(
          data.writer.readQuery({ transcriptVisibility: true }),
          { limit: 50 }
        );
        data.writer.readSelected(() => visible.positions, { transcriptVisibility: true });
        const transcriptMs = ms(at);
        replicaReads.push({ openMs, statusMs, latestTurnMs, transcriptMs });
        retained.push(data);
      }
      globalThis.gc?.();
      results.replica = {
        reads: replicaReads,
        daemonRssDeltaMb: mb(process.memoryUsage().rss - rssBefore),
        hostRssDeltaMb: mb((await rssOf(pid)) - hostBefore),
      };
      for (const data of retained) data.dispose();
      await repo.destroy();
    } finally {
      await connection.close();
      await stopHost(pid);
      await rm(dataDir, { recursive: true, force: true });
    }
    console.log(JSON.stringify(results, null, 2));
    const out = process.env.LODY_SESSION_LOAD_BENCH_OUT;
    if (out) await writeFile(out, JSON.stringify(results, null, 2));
  }, 3_600_000);
});

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { META_ROOM } from '@loro-dev/loro-repo-client';
import { connectEngine } from '@loro-dev/loro-repo-client/node';
import {
  ExternalMetadataNotCommittedError,
  LoroRepo,
  type JsonObject,
} from 'loro-repo';
import { Flock } from '@loro-dev/flock-wasm';
import { createNativeFlockDocs } from '../src/node/native-flock-docs';
import {
  connectNativeRepo,
  importLegacyRoom,
  type LegacyFlockBundle,
} from '../src/node/native-repo';
import {
  createNativeWorkspaceMeta,
} from '../src/node/native-workspace-meta';

// Opt-in: LODY_NATIVE_META_BENCH=1. Real host process, real socket connections.
const enabled = process.env.LODY_NATIVE_META_BENCH === '1';
const hostScript = fileURLToPath(new URL('./fixtures/native-repo-host.mjs', import.meta.url));
const notCommitted = (reason: string) => new ExternalMetadataNotCommittedError(reason);
const SAMPLES = 200;
const WARMUP = 20;

/** Legacy-layout bundle: half the documents are soft-deleted, a third have a tombstoned field. */
function syntheticBundle(docs: number): LegacyFlockBundle {
  const entries: Record<string, { c: string; d?: unknown }> = {};
  let tick = 0;
  const clock = () => `${1_700_000_000_000 + tick++},0,legacy-peer`;
  for (let i = 0; i < docs; i++) {
    const id = `session-${i.toString().padStart(7, '0')}`;
    entries[JSON.stringify(['e', id])] = { c: clock(), d: i % 2 === 0 };
    entries[JSON.stringify(['m', id, 'title'])] = { c: clock(), d: `Session ${i}` };
    entries[JSON.stringify(['m', id, 'lastMessageAt'])] = { c: clock(), d: i };
    if (i % 3 === 0) entries[JSON.stringify(['m', id, 'pinned'])] = { c: clock() };
  }
  return { version: 0, entries };
}

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
};
const summarize = (values: number[]) => ({
  p50: +percentile(values, 50).toFixed(3),
  p95: +percentile(values, 95).toFixed(3),
  p99: +percentile(values, 99).toFixed(3),
});

async function measure(run: (i: number) => Promise<unknown>) {
  for (let i = 0; i < WARMUP; i++) await run(i);
  const out: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const started = performance.now();
    await run(WARMUP + i);
    out.push(performance.now() - started);
  }
  return summarize(out);
}

async function bench(docs: number) {
  const dataDir = await mkdtemp(join(tmpdir(), `lody-native-meta-bench-${docs}-`));
  const ns = `bench-${docs}`;
  const connection = await connectNativeRepo({
    dataDir,
    launcher: () => ({ command: process.execPath, args: [hostScript] }),
  });
  const peer = await connectEngine(dataDir, { queueWhileReconnecting: false });
  try {
    const bundle = syntheticBundle(docs);
    let started = performance.now();
    await importLegacyRoom(connection.client, ns, META_ROOM, 'bench', async () => bundle);
    const migrationMs = performance.now() - started;
    const registers = Object.keys(bundle.entries).length;

    // Startup: open the daemon's repo (one subscription snapshot of the room).
    started = performance.now();
    const meta = createNativeWorkspaceMeta(connection.client, ns, notCommitted);
    const repo = await LoroRepo.createWithExternalMetadata<JsonObject>({}, meta);
    const startupMs = performance.now() - started;
    expect(repo.listDocSync().length).toBe(docs);

    // The other process's view, to time subscription delivery end to end.
    const otherMeta = createNativeWorkspaceMeta(peer, ns, notCommitted);
    const other = await LoroRepo.createWithExternalMetadata<JsonObject>({}, otherMeta);
    const ids = (i: number) => `session-${((i * 7919) % docs).toString().padStart(7, '0')}`;

    const read = await measure((i) => repo.getDocMeta(ids(i)));
    const boundedRead = await measure((i) =>
      connection.client.flockReadMany(
        ns,
        META_ROOM,
        [
          { kind: 'key', key: ['e', ids(i)] },
          { kind: 'prefix', prefix: ['m', ids(i)] },
        ],
        { maxRows: 64, maxBytes: 65536 }
      )
    );
    const write = await measure((i) => repo.upsertDocMeta(ids(i), { lastReadAt: i }));
    const update = await measure(
      (i) =>
        new Promise<void>((resolve, reject) => {
          const id = ids(i);
          const watch = other.watch((event) => {
            if (event.kind === 'doc-metadata' && event.docId === id) {
              watch.unsubscribe();
              resolve();
            }
          });
          repo.upsertDocMeta(id, { title: `t${i}` }).catch(reject);
        })
    );
    await other.destroy();
    await otherMeta.close();
    await repo.destroy();
    await meta.close();
    return {
      docs,
      registers,
      migrationMs: +migrationMs.toFixed(1),
      startupMs: +startupMs.toFixed(1),
      read,
      boundedRead,
      write,
      update,
    };
  } finally {
    await peer.close();
    const pid = (JSON.parse(await readFile(join(dataDir, 'engine.json'), 'utf8')) as { pid: number })
      .pid;
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

async function benchFlockDoc(rows: number) {
  const dataDir = await mkdtemp(join(tmpdir(), `lody-native-flock-bench-${rows}-`));
  const ns = `flock-${rows}`;
  const id = 'ws:wf:workspace';
  const connection = await connectNativeRepo({
    dataDir,
    launcher: () => ({ command: process.execPath, args: [hostScript] }),
  });
  const peer = await connectEngine(dataDir, { queueWhileReconnecting: false });
  const owner = (client: typeof peer) =>
    createNativeFlockDocs(client, ns, (doc) => doc === id, (file) => Flock.fromFile(file).exportJson());
  try {
    const seed = new Flock('seed');
    // Row shape of an MCP/Role catalog entry (~200 bytes of JSON).
    for (let i = 0; i < rows; i++)
      seed.put(['row', String(i)], { name: `row-${i}`, command: 'node', args: ['server.js', String(i)] });
    await importLegacyRoom(connection.client, ns, { kind: 'flock', id }, 'bench', async () =>
      seed.exportJson() as LegacyFlockBundle
    );
    const open = await measure(async () => {
      const repo = await LoroRepo.create({ externalFlockDocs: owner(connection.client) });
      await repo.openFlockDoc(id);
      await repo.destroy();
    });
    const daemon = await LoroRepo.create({ externalFlockDocs: owner(connection.client) });
    const renderer = await LoroRepo.create({ externalFlockDocs: owner(peer) });
    const a = await daemon.openFlockDoc(id);
    const b = await renderer.openFlockDoc(id);
    const write = await measure(async (i) => {
      a.flock.put(['row', String(i % rows)], { name: `w${i}` });
      await daemon.persistFlockDocNow(id, a.flock);
    });
    const update = await measure(async (i) => {
      const key = ['row', String(i % rows)];
      const seen = new Promise<void>((resolve) => {
        const stop = b.flock.subscribe(() => {
          if ((b.flock.get(key) as { name?: string } | undefined)?.name === `u${i}`) {
            stop();
            resolve();
          }
        });
      });
      a.flock.put(key, { name: `u${i}` });
      await daemon.persistFlockDocNow(id, a.flock);
      await seen;
    });
    await renderer.destroy();
    await daemon.destroy();
    return { rows, fileBytes: seed.exportFile().length, open, write, update };
  } finally {
    await peer.close();
    const pid = (JSON.parse(await readFile(join(dataDir, 'engine.json'), 'utf8')) as { pid: number })
      .pid;
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

describe.skipIf(!enabled)('native named Flock document benchmark', () => {
  it('opens and writes catalog-sized rooms', async () => {
    const results = [];
    for (const rows of [24, 524, 5000]) results.push(await benchFlockDoc(rows));
    const out = process.env.LODY_NATIVE_META_BENCH_OUT;
    if (out) await writeFile(out.replace(/\.json$/, '-flock.json'), JSON.stringify(results, null, 2));
  }, 600_000);
});

describe.skipIf(!enabled)('native Workspace Meta benchmark', () => {
  it('keeps per-operation latency flat from 10k to 100k documents', async () => {
    const results = [];
    for (const docs of [10_000, 100_000]) results.push(await bench(docs));
    const out = process.env.LODY_NATIVE_META_BENCH_OUT;
    if (out) await writeFile(out, JSON.stringify(results, null, 2));
  }, 600_000);
});

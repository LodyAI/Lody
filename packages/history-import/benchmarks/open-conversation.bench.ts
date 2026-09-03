/**
 * tinybench baseline for opening a long conversation: Loro snapshot ->
 * render-ready `SessionHistory[]`.
 *
 * The fixture is a desensitized real Lody conversation (see `capture-fixture.ts`),
 * replicated `--scale` times to model conversations longer than anything on this
 * machine today. Replication rewrites entry ids so the history list keeps unique
 * keys, and every replica is a distinct container subtree, so container count —
 * the thing this cost actually tracks — scales linearly with `--scale`.
 *
 *   pnpm --filter @lody/history-import bench:open -- --fixture=/tmp/fixture.json
 *   pnpm --filter @lody/history-import bench:open -- --fixture=... --scale=10 --iterations=10
 *   pnpm --filter @lody/history-import bench:open -- --fixture=... --scale=1,10,100
 *
 * Tasks per scale:
 *   import              LoroDoc.import(snapshot) — decode only
 *   toJSON              doc.toJSON() — full bulk materialization in Rust, no ids
 *   getDeepValueWithID  same, carrying container ids (what a bulk Mirror needs)
 *   Mirror              new Mirror(...) — what a client pays today
 *   getState            mirror.getState() — cached read
 */

import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sessionDocSchema, type SessionHistoryInput, type SessionId } from '@lody/shared';
import { LoroDoc } from 'loro-crdt';
import { Mirror } from 'loro-mirror';
import { Bench } from 'tinybench';

const BENCH_SESSION_ID = 'bench-session' as SessionId;

function expandHome(value: string): string {
  return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}

function readFlag(name: string): string | null {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

function loadFixture(): SessionHistoryInput[] {
  const fixture = readFlag('fixture') ?? path.join(os.tmpdir(), 'lody-conversation-fixture.json');
  const file = expandHome(fixture);
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as SessionHistoryInput[];
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${file} is not a non-empty history array; run bench:capture first`);
  }
  return parsed;
}

/** `history` repeated `scale` times with unique entry ids. */
function scaleHistory(history: readonly SessionHistoryInput[], scale: number): SessionHistoryInput[] {
  if (scale === 1) return history as SessionHistoryInput[];
  const out: SessionHistoryInput[] = [];
  for (let copy = 0; copy < scale; copy += 1) {
    for (const entry of history) {
      out.push({ ...entry, id: `${entry.id}:r${copy}` });
    }
  }
  return out;
}

function buildSnapshot(history: SessionHistoryInput[]): Uint8Array {
  const doc = new LoroDoc();
  const mirror = new Mirror({
    doc,
    schema: sessionDocSchema,
    ignoreUnknownProperties: true,
    initialState: { session: { id: BENCH_SESSION_ID }, history: [] },
  });
  mirror.setState((prev) => ({ ...prev, history: history as never }));
  doc.commit();
  return doc.export({ mode: 'snapshot' });
}

function importedDoc(snapshot: Uint8Array): LoroDoc {
  const doc = new LoroDoc();
  doc.import(snapshot);
  return doc;
}

function countItems(history: readonly { items?: unknown }[]): number {
  let total = 0;
  for (const entry of history) if (Array.isArray(entry.items)) total += entry.items.length;
  return total;
}

/**
 * One `LoroMap` per turn and per message item, one `LoroList` per turn's items
 * and per plan, one `LoroText` per text-bearing item. This is the number the
 * open cost tracks, so it belongs next to every measurement.
 */
function countContainers(history: readonly SessionHistoryInput[]): number {
  let containers = 1; // the history list itself
  for (const entry of history) {
    containers += 1; // turn map
    const items = Array.isArray(entry.items) ? entry.items : [];
    if (items.length > 0) containers += 1; // items list
    for (const item of items as Record<string, unknown>[]) {
      containers += 1; // item map
      if (typeof item.text === 'string') containers += 1; // LoroText
    }
    if (Array.isArray(entry.plan) && entry.plan.length > 0) {
      containers += 1 + entry.plan.length;
    }
  }
  return containers;
}

async function main(): Promise<void> {
  const base = loadFixture();
  const scales = (readFlag('scale') ?? '1,10')
    .split(',')
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isFinite(value) && value > 0);
  const iterations = Number.parseInt(readFlag('iterations') ?? '10', 10);

  process.stdout.write(
    `fixture: ${base.length} turns, ${countItems(base)} message items\n` +
      `scales: ${scales.join(', ')}   iterations: ${iterations}\n\n`
  );

  for (const scale of scales) {
    const history = scaleHistory(base, scale);
    const snapshot = buildSnapshot(history);
    const containers = countContainers(history);
    const preImported = importedDoc(snapshot);
    let mirror: Mirror<typeof sessionDocSchema> | null = null;

    // `time: 0` with an explicit iteration count keeps every task at exactly the
    // requested number of runs: a 100x doc takes seconds per run, and tinybench's
    // default time budget would otherwise decide the sample size for us.
    const bench = new Bench({ time: 0, iterations, warmupIterations: 1 });

    bench
      .add('import', () => {
        importedDoc(snapshot);
      })
      .add('toJSON', () => {
        preImported.toJSON();
      })
      .add('getDeepValueWithID', () => {
        (preImported as unknown as { getDeepValueWithID(): unknown }).getDeepValueWithID();
      })
      .add('Mirror', () => {
        mirror = new Mirror({
          doc: importedDoc(snapshot),
          schema: sessionDocSchema,
          ignoreUnknownProperties: true,
          initialState: { session: { id: BENCH_SESSION_ID }, history: [] },
        });
      })
      .add('getState', () => {
        mirror?.getState();
      });

    await bench.run();

    const rows = bench.tasks.map((task) => ({
      task: task.name,
      'mean ms': Number((task.result?.latency.mean ?? 0).toFixed(1)),
      'p99 ms': Number((task.result?.latency.p99 ?? 0).toFixed(1)),
      'ops/sec': Number((task.result?.throughput.mean ?? 0).toFixed(1)),
      samples: task.result?.latency.samples.length ?? 0,
    }));

    process.stdout.write(
      `scale x${scale}: ${history.length} turns, ${countItems(history)} items, ` +
        `${containers} containers, snapshot ${(snapshot.byteLength / 1024 / 1024).toFixed(1)} MiB\n`
    );
    console.table(rows);
    const mirrorMean = bench.tasks.find((task) => task.name === 'Mirror')?.result?.latency.mean ?? 0;
    process.stdout.write(
      `  ${(mirrorMean * 1000).toFixed(0)} µs/turn, ` +
        `${((mirrorMean * 1000) / Math.max(containers, 1)).toFixed(1)} µs/container\n\n`
    );
  }
}

void main();

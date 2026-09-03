/**
 * tinybench baseline for opening a long conversation: Loro snapshot ->
 * render-ready rows, before (full-schema Mirror) and after (ConversationView).
 *
 * The fixture is synthetic by default (`./fixture.ts`, deterministic), or a
 * desensitized real Lody conversation via `--fixture` (see `capture-fixture.ts`;
 * never commit one). Either is replicated `--scale` times to model conversations
 * longer than anything on this machine today. Replication rewrites entry ids so
 * the history list keeps unique keys, and every replica is a distinct container
 * subtree, so container count — the thing the open cost actually tracks —
 * scales linearly with `--scale`.
 *
 *   pnpm --filter @lody/history-import bench:open
 *   pnpm --filter @lody/history-import bench:open -- --turns=240 --scale=1,10
 *   pnpm --filter @lody/history-import bench:open -- --fixture=/tmp/fixture.json --scale=1,10 --iterations=10
 *
 * Tasks per scale:
 *   import              LoroDoc.import(snapshot) — decode only
 *   toJSON              doc.toJSON() — full bulk materialization in Rust, no ids
 *   getDeepValueWithID  same, carrying container ids (what a bulk Mirror needs)
 *   Mirror              import + new Mirror(...) — what a client paid before
 *   getState            mirror.getState() — cached read
 *   view.open           import + createConversationViewFromDoc + tail hydrate
 *                       -> one renderable row per turn (placeholder or message).
 *                       The renderer's `buildChatStreamItemsFromView` adds only
 *                       item normalization for the hydrated tail on top of this.
 *   view.readAll        import + view + readAll(): what a reader still on the
 *                       `doc.history` bridge pays on first access (toJSON per turn,
 *                       no Mirror)
 *   view.scroll         ensureRange over a 30-turn window that advances each
 *                       iteration (20 iterations): what a scroll costs
 *   view.stream         one text delta into the tail turn + commit, with the
 *                       view attached (100 iterations): what a streamed token costs
 *   view.append         appendHistoryEntry of one user turn with the view attached
 *
 * Acceptance from the phase 1b task: view.open <= 50 ms at x10 (~2,400 turns)
 * and view.stream p99 <= 4 ms. The summary line prints both checks.
 */

import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sessionDocSchema, type SessionHistoryInput, type SessionId } from '@lody/shared';
import { LoroDoc, LoroList, LoroMap, LoroText } from 'loro-crdt';
import { Mirror } from 'loro-mirror';
import { Bench } from 'tinybench';

// Benchmarks are the one consumer allowed to reach into the client's read
// model: the view is the thing being measured, and it depends on nothing but
// loro-crdt and @lody/shared types.
import {
  createConversationViewFromDoc,
  type ConversationView,
} from '../../components/src/lib/conversation-view/conversation-view';
import { appendHistoryEntry } from '../../components/src/lib/conversation-view/history-writer';
import { materializeReplay } from '../src/materialize';
import { buildSyntheticReplay, DEFAULT_SYNTHETIC_REPLAY } from './fixture';

const BENCH_SESSION_ID = 'bench-session' as SessionId;
const PROVIDER = { cliType: 'builtin', agentType: 'claude' } as const;
const SCROLL_WINDOW = 30;
const SCROLL_ITERATIONS = 20;
const STREAM_ITERATIONS = 100;
const OPEN_BUDGET_MS = 50;
const STREAM_P99_BUDGET_MS = 4;

function expandHome(value: string): string {
  return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}

function readFlag(name: string): string | null {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

function loadFixture(): { history: SessionHistoryInput[]; source: string } {
  const fixture = readFlag('fixture');
  if (fixture) {
    const file = expandHome(fixture);
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as SessionHistoryInput[];
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error(`${file} is not a non-empty history array; run bench:capture first`);
    }
    return { history: parsed, source: `captured (${path.basename(file)})` };
  }
  const turns = Number.parseInt(readFlag('turns') ?? String(DEFAULT_SYNTHETIC_REPLAY.turns), 10);
  const materialized = materializeReplay({
    provider: PROVIDER,
    acpSessionId: 'bench-acp-session' as never,
    replayNotifications: buildSyntheticReplay({ ...DEFAULT_SYNTHETIC_REPLAY, turns }),
    userId: 'bench-user',
    nowIso: '2026-01-01T00:00:00.000Z',
  });
  return { history: materialized.history, source: `synthetic (turns=${turns})` };
}

/** `history` repeated `scale` times with unique entry ids. */
function scaleHistory(
  history: readonly SessionHistoryInput[],
  scale: number
): SessionHistoryInput[] {
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

type RenderRow =
  | { kind: 'message'; key: string; itemCount: number }
  | { kind: 'placeholder'; key: string };

/** One row per turn, from the hydrated tail or the index — what the stream builds. */
function renderRows(view: ConversationView): RenderRow[] {
  const rows: RenderRow[] = [];
  for (let i = 0; i < view.turnCount; i += 1) {
    const turn = view.turn(i);
    if (turn) {
      rows.push({
        kind: 'message',
        key: turn.id,
        itemCount: Array.isArray(turn.items) ? turn.items.length : 0,
      });
      continue;
    }
    const row = view.index(i);
    if (row?.id) rows.push({ kind: 'placeholder', key: row.id });
  }
  return rows;
}

/** The last `LoroText` item of the last turn: where a streamed token lands. */
function tailTextContainer(doc: LoroDoc): LoroText {
  const cids = doc.getList('history').getShallowValue() as string[];
  for (let turnIndex = cids.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = doc.getContainerById(cids[turnIndex] as never);
    if (!(turn instanceof LoroMap)) continue;
    const items = turn.get('items');
    if (!(items instanceof LoroList)) continue;
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items.get(i);
      if (!(item instanceof LoroMap)) continue;
      const text = item.get('text');
      if (text instanceof LoroText) return text;
    }
  }
  throw new Error('fixture has no text item to stream into');
}

const appendedUserTurn = (index: number): SessionHistoryInput => ({
  id: `bench-append-${index}`,
  role: 'user',
  timestamp: '2026-01-01T00:00:00.000Z',
  status: 'pending',
  read: false,
  finished: true,
  fileDiff: [],
  items: [{ type: 'text', text: `follow-up ${index}` }] as never,
  inputConfig: { prompt: `follow-up ${index}`, cliType: 'builtin', agentType: 'claude' } as never,
});

type Row = {
  task: string;
  'mean ms': number;
  'p99 ms': number;
  'ops/sec': number;
  samples: number;
  error?: string;
};

const rowsOf = (bench: Bench): Row[] =>
  bench.tasks.map((task) => ({
    task: task.name,
    'mean ms': Number((task.result?.mean ?? 0).toFixed(2)),
    'p99 ms': Number((task.result?.p99 ?? 0).toFixed(2)),
    'ops/sec': Number((task.result?.hz ?? 0).toFixed(1)),
    samples: task.result?.samples?.length ?? 0,
    // A task that threw (the full Mirror on a large doc can) has `result.error`
    // and no samples; report it instead of crashing the whole run.
    ...(task.result?.error
      ? { error: String((task.result.error as { message?: string }).message ?? task.result.error) }
      : {}),
  }));

const meanOf = (bench: Bench, name: string): number =>
  bench.tasks.find((task) => task.name === name)?.result?.mean ?? 0;
const p99Of = (bench: Bench, name: string): number =>
  bench.tasks.find((task) => task.name === name)?.result?.p99 ?? 0;

async function main(): Promise<void> {
  const { history: base, source } = loadFixture();
  const scales = (readFlag('scale') ?? '1,10')
    .split(',')
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isFinite(value) && value > 0);
  const iterations = Number.parseInt(readFlag('iterations') ?? '10', 10);

  process.stdout.write(
    `fixture: ${source}, ${base.length} turns, ${countItems(base)} message items\n` +
      `scales: ${scales.join(', ')}   iterations: ${iterations}\n\n`
  );

  const progress = (message: string) => process.stderr.write(`  … ${message}\n`);

  for (const scale of scales) {
    const history = scaleHistory(base, scale);
    progress(`x${scale}: building snapshot (${history.length} turns)`);
    const snapshot = buildSnapshot(history);
    const containers = countContainers(history);
    const preImported = importedDoc(snapshot);
    let mirror: Mirror<typeof sessionDocSchema> | null = null;

    // `time: 0` with an explicit iteration count keeps every task at exactly the
    // requested number of runs: a 100x doc takes seconds per run, and tinybench's
    // default time budget would otherwise decide the sample size for us.
    // View tasks run first: the Mirror baseline allocates the whole
    // transcript per iteration, and measuring the view on that heap would
    // charge its garbage collection to the view.
    const viewBench = new Bench({ time: 0, iterations, warmupIterations: 1 });
    viewBench
      .add('view.open', () => {
        const view = createConversationViewFromDoc(importedDoc(snapshot), {
          sessionId: BENCH_SESSION_ID,
        });
        renderRows(view);
        view.dispose();
      })
      .add('view.readAll', () => {
        const view = createConversationViewFromDoc(importedDoc(snapshot), {
          sessionId: BENCH_SESSION_ID,
        });
        view.readAll();
        view.dispose();
      });
    progress(`x${scale}: view.open / view.readAll`);
    await viewBench.run();

    let scrollView: ConversationView | null = null;
    let cursor = 0;
    const scrollBench = new Bench({ time: 0, iterations: SCROLL_ITERATIONS, warmupIterations: 0 });
    scrollBench.add(
      'view.scroll',
      async () => {
        const view = scrollView;
        if (!view) return;
        await view.ensureRange(cursor, cursor + SCROLL_WINDOW);
        cursor = (cursor + SCROLL_WINDOW) % Math.max(1, view.turnCount - SCROLL_WINDOW);
      },
      {
        beforeAll: () => {
          scrollView = createConversationViewFromDoc(preImported, { sessionId: BENCH_SESSION_ID });
          cursor = 0;
        },
        afterAll: () => {
          scrollView?.dispose();
          scrollView = null;
        },
      }
    );
    progress(`x${scale}: scroll`);
    await scrollBench.run();

    let streamDoc: LoroDoc | null = null;
    let streamView: ConversationView | null = null;
    let streamText: LoroText | null = null;
    let appended = 0;
    const streamBench = new Bench({ time: 0, iterations: STREAM_ITERATIONS, warmupIterations: 0 });
    streamBench
      .add(
        'view.stream',
        () => {
          if (!streamDoc || !streamText) return;
          streamText.insert(streamText.length, ' token');
          streamDoc.commit();
        },
        {
          beforeAll: () => {
            streamDoc = importedDoc(snapshot);
            streamView = createConversationViewFromDoc(streamDoc, { sessionId: BENCH_SESSION_ID });
            streamText = tailTextContainer(streamDoc);
          },
          afterAll: () => {
            streamView?.dispose();
            streamView = null;
            streamText = null;
          },
        }
      )
      .add(
        'view.append',
        () => {
          if (!streamDoc) return;
          appendHistoryEntry(streamDoc, appendedUserTurn((appended += 1)));
        },
        {
          beforeAll: () => {
            streamDoc = importedDoc(snapshot);
            streamView = createConversationViewFromDoc(streamDoc, { sessionId: BENCH_SESSION_ID });
            appended = 0;
          },
          afterAll: () => {
            streamView?.dispose();
            streamView = null;
            streamDoc = null;
          },
        }
      );
    progress(`x${scale}: stream + append`);
    await streamBench.run();

    const openBench = new Bench({ time: 0, iterations, warmupIterations: 1 });
    openBench
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
    progress(`x${scale}: baseline (import / toJSON / Mirror)`);
    await openBench.run();

    process.stdout.write(
      `scale x${scale}: ${history.length} turns, ${countItems(history)} items, ` +
        `${containers} containers, snapshot ${(snapshot.byteLength / 1024 / 1024).toFixed(1)} MiB\n`
    );
    console.table([
      ...rowsOf(openBench),
      ...rowsOf(viewBench),
      ...rowsOf(scrollBench),
      ...rowsOf(streamBench),
    ]);
    const mirrorMean = meanOf(openBench, 'Mirror');
    const mirrorError = openBench.tasks.find((task) => task.name === 'Mirror')?.result?.error;
    const openMean = meanOf(viewBench, 'view.open');
    const streamP99 = p99Of(streamBench, 'view.stream');
    const before = mirrorError
      ? `  before (Mirror): FAILED (${String((mirrorError as { message?: string }).message ?? mirrorError)})\n`
      : `  before (Mirror): ${mirrorMean.toFixed(1)} ms = ` +
        `${((mirrorMean * 1000) / Math.max(history.length, 1)).toFixed(0)} µs/turn, ` +
        `${((mirrorMean * 1000) / Math.max(containers, 1)).toFixed(1)} µs/container\n`;
    const speedup = mirrorError
      ? ''
      : ` (${(mirrorMean / Math.max(openMean, 1e-6)).toFixed(1)}x faster)`;
    process.stdout.write(
      before +
        `  after (view.open): ${openMean.toFixed(1)} ms${speedup}` +
        `  open<=${OPEN_BUDGET_MS}ms: ${openMean <= OPEN_BUDGET_MS ? 'PASS' : 'FAIL'}` +
        `  stream p99<=${STREAM_P99_BUDGET_MS}ms: ${streamP99 <= STREAM_P99_BUDGET_MS ? 'PASS' : 'FAIL'} (${streamP99.toFixed(2)} ms)\n\n`
    );
  }
}

void main();

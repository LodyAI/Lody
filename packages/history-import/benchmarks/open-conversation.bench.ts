/**
 * tinybench for opening, scrolling, and streaming a long conversation.
 *
 * Fixture: a desensitized real Lody conversation (`--fixture`, see
 * `capture-fixture.ts`; never committed) or, by default, the synthetic replay
 * from `fixture.ts`. Either is replicated `--scale` times so container count —
 * the thing every cost here tracks — grows linearly.
 *
 *   pnpm --filter @lody/history-import bench:open                       # synthetic x1,x10
 *   pnpm --filter @lody/history-import bench:open -- --scale=1,10,100
 *   pnpm --filter @lody/history-import bench:open -- --fixture=/tmp/fixture.json
 *
 * Tasks per scale (ms):
 *   import      LoroDoc.import(snapshot) — decode only
 *   Mirror      new Mirror(...) — what a client paid before ConversationView
 *   open        import + createConversationViewFromDoc + the rows the first
 *               paint reads (every index row, the hydrated tail) — what a client pays now
 *   open+idle   open, plus the background summary pass driven to completion
 *   scroll      one ensureRange of 30 turns at a rotating offset on an open view
 *               (20+ iterations; read the p99 column)
 *   stream      one text delta appended to the tail turn with the view subscribed
 *   stream(Mirror) the same delta with a full Mirror subscribed instead
 */

import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sessionDocSchema, type SessionHistoryInput, type SessionId } from '@lody/shared';
import {
  isContainer,
  LoroDoc,
  type ContainerID,
  type LoroList,
  type LoroMap,
  type LoroText,
} from 'loro-crdt';
import { Mirror } from 'loro-mirror';
import { Bench } from 'tinybench';

// Benchmarks import the view implementation by path: this package stays a
// pure domain package with no dependency on `@lody/components`.
import { createConversationViewFromDoc } from '../../components/src/lib/conversation-view/create-conversation-view-from-doc';
import type { ConversationView } from '../../components/src/lib/conversation-view/types';
import { materializeReplay } from '../src/materialize';
import { buildSyntheticReplay, DEFAULT_SYNTHETIC_REPLAY } from './fixture';

const BENCH_SESSION_ID = 'bench-session' as SessionId;
const TAIL_KEEP = 20;
const SCROLL_WINDOW = 30;

function expandHome(value: string): string {
  return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}

function readFlag(name: string): string | null {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

function loadFixture(): { history: SessionHistoryInput[]; label: string } {
  const flag = readFlag('fixture');
  const file = flag ? expandHome(flag) : path.join(os.tmpdir(), 'lody-conversation-fixture.json');
  if (flag || existsSync(file)) {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as SessionHistoryInput[];
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error(`${file} is not a non-empty history array; run bench:capture first`);
    }
    return { history: parsed, label: `desensitized fixture ${file}` };
  }
  const replay = buildSyntheticReplay(DEFAULT_SYNTHETIC_REPLAY);
  const history = materializeReplay({
    provider: { cliType: 'builtin', agentType: 'claude' },
    acpSessionId: 'bench-acp-session' as never,
    replayNotifications: replay,
    userId: 'bench-user',
    nowIso: '2026-01-01T00:00:00.000Z',
  }).history;
  return { history, label: 'synthetic replay (fixture.ts)' };
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

/** Written through today's Mirror path, so the doc is what a CLI produces. */
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
  mirror.dispose();
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

/** Idle work is run explicitly by the tasks that measure it. */
type IdleTask = (deadline: { timeRemaining(): number }) => void;
function createManualIdle() {
  const tasks: IdleTask[] = [];
  return {
    scheduleIdle: (task: IdleTask) => {
      tasks.push(task);
      return () => {
        const at = tasks.indexOf(task);
        if (at >= 0) tasks.splice(at, 1);
      };
    },
    runAll: () => {
      while (tasks.length > 0) tasks.shift()!({ timeRemaining: () => 50 });
    },
  };
}

function openView(doc: LoroDoc, idle = createManualIdle()): ConversationView {
  return createConversationViewFromDoc(doc, {
    sessionId: BENCH_SESSION_ID,
    tailKeep: TAIL_KEEP,
    scheduleIdle: idle.scheduleIdle,
    yieldToEventLoop: () => Promise.resolve(),
  });
}

/** What the first paint reads: every index row plus the hydrated tail turns. */
function readFirstPaint(view: ConversationView): number {
  let rows = 0;
  for (let i = 0; i < view.turnCount; i += 1) if (view.index(i)) rows += 1;
  for (let i = Math.max(0, view.turnCount - TAIL_KEEP); i < view.turnCount; i += 1) {
    if (view.turn(i)) rows += 1;
  }
  return rows;
}

function tailText(doc: LoroDoc): LoroText {
  const list = doc.getList('history') as LoroList;
  const cids = list.getShallowValue() as ContainerID[];
  const turn = doc.getContainerById(cids[cids.length - 1]!) as LoroMap;
  const items = turn.get('items') as LoroList;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items.get(i) as LoroMap;
    const text = item.get('text');
    if (isContainer(text) && text.kind() === 'Text') return text as LoroText;
  }
  throw new Error('tail turn has no text item');
}

async function main(): Promise<void> {
  const { history: base, label } = loadFixture();
  const scales = (readFlag('scale') ?? '1,10')
    .split(',')
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isFinite(value) && value > 0);
  const iterations = Number.parseInt(readFlag('iterations') ?? '10', 10);

  process.stdout.write(
    `fixture: ${label}\n${base.length} turns, ${countItems(base)} message items\n` +
      `scales: ${scales.join(', ')}   iterations: ${iterations}\n\n`
  );

  for (const scale of scales) {
    const history = scaleHistory(base, scale);
    const snapshot = buildSnapshot(history);
    const preImported = importedDoc(snapshot);

    // Long-lived state for the scroll and stream tasks.
    const scrollView = openView(importedDoc(snapshot));
    let scrollOffset = 0;
    const streamDoc = importedDoc(snapshot);
    const streamView = openView(streamDoc);
    let streamEvents = 0;
    streamView.subscribe(() => {
      streamEvents += 1;
    });
    const streamText = tailText(streamDoc);
    const mirrorStreamDoc = importedDoc(snapshot);
    const mirrorStream = new Mirror({
      doc: mirrorStreamDoc,
      schema: sessionDocSchema,
      ignoreUnknownProperties: true,
      initialState: { session: { id: BENCH_SESSION_ID }, history: [] },
    });
    const mirrorStreamText = tailText(mirrorStreamDoc);
    let delta = 0;

    // `time: 0` with an explicit iteration count keeps every task at exactly the
    // requested number of runs; a 100x doc takes seconds per Mirror run. The
    // per-event tasks get their own bench so their p99 rests on enough samples.
    const bench = new Bench({ time: 0, iterations, warmupIterations: 1 });
    const eventBench = new Bench({
      time: 0,
      iterations: Math.max(iterations, 100),
      warmupIterations: 1,
    });

    bench
      .add('import', () => {
        importedDoc(snapshot);
      })
      .add('Mirror', () => {
        const mirror = new Mirror({
          doc: importedDoc(snapshot),
          schema: sessionDocSchema,
          ignoreUnknownProperties: true,
          initialState: { session: { id: BENCH_SESSION_ID }, history: [] },
        });
        mirror.dispose();
      })
      .add('open', () => {
        const view = openView(importedDoc(snapshot));
        readFirstPaint(view);
        view.dispose();
      })
      .add('open+idle', () => {
        const idle = createManualIdle();
        const view = openView(importedDoc(snapshot), idle);
        readFirstPaint(view);
        idle.runAll();
        view.dispose();
      });
    eventBench
      .add('scroll', async () => {
        const from = scrollOffset;
        const to = Math.min(scrollView.turnCount, from + SCROLL_WINDOW);
        await scrollView.ensureRange(from, to);
        for (let i = from; i < to; i += 1) scrollView.turn(i);
        scrollView.release(from, to);
        scrollOffset = (scrollOffset + SCROLL_WINDOW * 7) % Math.max(1, scrollView.turnCount);
      })
      .add('stream', () => {
        delta += 1;
        streamText.insert(streamText.length, ` token${delta}`);
        streamDoc.commit();
      })
      .add('stream(Mirror)', () => {
        delta += 1;
        mirrorStreamText.insert(mirrorStreamText.length, ` token${delta}`);
        mirrorStreamDoc.commit();
      });

    const logCycle = (event: Event) => {
      const task = (event as unknown as { task?: { name: string } }).task;
      if (task) process.stderr.write(`  done: ${task.name}\n`);
    };
    bench.addEventListener('cycle', logCycle);
    eventBench.addEventListener('cycle', logCycle);
    await bench.run();
    await eventBench.run();
    void preImported;
    mirrorStream.dispose();

    const tasks = [...bench.tasks, ...eventBench.tasks];
    for (const task of tasks) {
      if (task.result?.error) throw task.result.error;
    }
    // tinybench 2.x reports latency stats on the result itself; 3.x nests
    // them under `latency`. Read whichever shape is present.
    type LatencyStats = { mean?: number; p99?: number; max?: number; samples?: unknown[] };
    const statsOf = (task: (typeof tasks)[number]): LatencyStats => {
      const result = task.result as (LatencyStats & { latency?: LatencyStats }) | undefined;
      return result?.latency ?? result ?? {};
    };
    const rows = tasks.map((task) => {
      const stats = statsOf(task);
      return {
        task: task.name,
        'mean ms': Number((stats.mean ?? 0).toFixed(2)),
        'p99 ms': Number((stats.p99 ?? 0).toFixed(2)),
        'max ms': Number((stats.max ?? 0).toFixed(2)),
        samples: stats.samples?.length ?? 0,
      };
    });

    process.stdout.write(
      `scale x${scale}: ${history.length} turns, ${countItems(history)} items, ` +
        `snapshot ${(snapshot.byteLength / 1024 / 1024).toFixed(1)} MiB, ` +
        `stream events observed: ${streamEvents}\n`
    );
    console.table(rows);
    const meanOf = (name: string) => statsOf(tasks.find((task) => task.name === name)!).mean ?? 0;
    const mirrorMean = meanOf('Mirror');
    const openMean = meanOf('open');
    const perTurn = (ms: number) => ((ms * 1000) / Math.max(history.length, 1)).toFixed(1);
    process.stdout.write(
      `  Mirror ${perTurn(mirrorMean)} µs/turn vs open ${perTurn(openMean)} µs/turn` +
        ` (${(mirrorMean / Math.max(openMean, 1e-6)).toFixed(0)}x)\n\n`
    );
    scrollView.dispose();
    streamView.dispose();
  }
}

void main();

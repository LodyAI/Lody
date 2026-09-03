/**
 * Baseline for the two costs a long imported conversation pays.
 *
 * Phase 1 (import): provider replay notifications -> materialized history rows
 *   -> Loro session doc -> exported snapshot.
 * Phase 2 (open): snapshot -> LoroDoc -> Mirror state, i.e. the render-ready
 *   `SessionHistory[]` a client hands to the conversation view.
 *
 * Run from the repository root:
 *   pnpm --filter @lody/history-import bench
 *   pnpm --filter @lody/history-import bench -- --turns=240 --iterations=5
 *   pnpm --filter @lody/history-import bench -- --notifications=/tmp/replay.json
 *   pnpm --filter @lody/history-import bench -- --repo=~/.lody/loro-repo/<ws>/repo.sqlite3 \
 *       --session=<sessionId>
 *
 * `--notifications` takes a locally captured replay (see
 * `apps/cli/scripts/dump-history-import-fixture.ts`); `--repo`/`--session` read a
 * real session doc snapshot out of a local loro-repo so phase 2 measures the doc a
 * user's machine actually opens. Neither artifact may be committed.
 */

import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
// `node:sqlite` is experimental in Node 22; only the opt-in `--repo` path uses it.
import { DatabaseSync } from 'node:sqlite';

import {
  parseSessionNotification,
  sessionDocSchema,
  type AcpSessionNotification,
  type SessionHistoryInput,
  type SessionId,
} from '@lody/shared';
import { LoroDoc } from 'loro-crdt';
import { Mirror } from 'loro-mirror';

import { materializeReplay, type MaterializedReplay } from '../src/materialize';
import { buildHistoryReplayImport } from '../src/replay-import';
import {
  buildSyntheticReplay,
  DEFAULT_SYNTHETIC_REPLAY,
  type SyntheticReplayOptions,
} from './fixture';

type Options = {
  synthetic: SyntheticReplayOptions;
  notificationsPath: string | null;
  snapshotPath: string | null;
  repoPath: string | null;
  sessionId: string | null;
  iterations: number;
  json: boolean;
};

const PROVIDER = { cliType: 'builtin', agentType: 'claude' } as const;
const ACP_SESSION_ID = 'bench-acp-session' as never;
const BENCH_SESSION_ID = 'bench-session' as SessionId;

function expandHome(value: string): string {
  return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}

function parseOptions(argv: readonly string[]): Options {
  const read = (name: string): string | null => {
    const prefix = `--${name}=`;
    const hit = argv.find((arg) => arg.startsWith(prefix));
    return hit ? hit.slice(prefix.length) : null;
  };
  const readInt = (name: string, fallback: number): number => {
    const raw = read(name);
    if (raw === null) return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`--${name} must be a positive integer`);
    }
    return parsed;
  };

  return {
    synthetic: {
      turns: readInt('turns', DEFAULT_SYNTHETIC_REPLAY.turns),
      toolCallsPerTurn: readInt('tool-calls', DEFAULT_SYNTHETIC_REPLAY.toolCallsPerTurn),
      textChunksPerTurn: readInt('text-chunks', DEFAULT_SYNTHETIC_REPLAY.textChunksPerTurn),
      chunkChars: readInt('chunk-chars', DEFAULT_SYNTHETIC_REPLAY.chunkChars),
    },
    notificationsPath: read('notifications'),
    snapshotPath: read('snapshot'),
    repoPath: read('repo'),
    sessionId: read('session'),
    iterations: readInt('iterations', 3),
    json: argv.includes('--json'),
  };
}

type Sample = { label: string; msPerRun: number[]; detail?: string };

function measure<T>(samples: Sample[], label: string, iterations: number, run: () => T): T {
  return measureWithSetup(samples, label, iterations, () => undefined, run);
}

/** `setup` runs per iteration outside the timer, so each stage is measured alone. */
function measureWithSetup<S, T>(
  samples: Sample[],
  label: string,
  iterations: number,
  setup: () => S,
  run: (input: S) => T
): T {
  const durations: number[] = [];
  let last: T | undefined;
  for (let index = 0; index < iterations; index += 1) {
    const input = setup();
    const start = performance.now();
    last = run(input);
    durations.push(performance.now() - start);
  }
  samples.push({ label, msPerRun: durations });
  return last as T;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

function loadNotifications(options: Options): {
  notifications: AcpSessionNotification[];
  rawNotifications: unknown[];
  source: string;
} {
  if (options.notificationsPath) {
    const file = expandHome(options.notificationsPath);
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    const rawNotifications = Array.isArray(parsed)
      ? parsed
      : ((parsed as { notifications?: unknown[] }).notifications ?? []);
    if (!Array.isArray(rawNotifications)) {
      throw new Error(`${file} does not contain a notifications array`);
    }
    return {
      notifications: rawNotifications.map((value) => parseSessionNotification(value)),
      rawNotifications,
      source: `captured replay (${path.basename(file)})`,
    };
  }

  const notifications = buildSyntheticReplay(options.synthetic);
  return {
    notifications,
    rawNotifications: notifications as unknown as unknown[],
    source:
      `synthetic (turns=${options.synthetic.turns}, ` +
      `toolCalls/turn=${options.synthetic.toolCallsPerTurn}, ` +
      `textChunks/turn=${options.synthetic.textChunksPerTurn})`,
  };
}

function readSnapshotFromRepo(repoPath: string, sessionId: string): Uint8Array {
  const db = new DatabaseSync(expandHome(repoPath), { readOnly: true });
  try {
    const docId = sessionId.startsWith('session-') ? sessionId : `session-${sessionId}`;
    const row = db.prepare('select snapshot from docs where doc_id = ?').get(docId) as
      | { snapshot: Uint8Array }
      | undefined;
    if (!row?.snapshot) {
      throw new Error(`No snapshot for ${docId} in ${repoPath}`);
    }
    return new Uint8Array(row.snapshot);
  } finally {
    db.close();
  }
}

function writeHistoryToDoc(history: SessionHistoryInput[]): LoroDoc {
  const doc = new LoroDoc();
  const mirror = new Mirror({
    doc,
    schema: sessionDocSchema,
    ignoreUnknownProperties: true,
    initialState: { session: { id: BENCH_SESSION_ID }, history: [] },
  });
  mirror.setState((prev) => ({ ...prev, history: history as never }));
  doc.commit();
  return doc;
}

function countItems(history: readonly { items?: unknown }[]): number {
  let total = 0;
  for (const entry of history) {
    if (Array.isArray(entry.items)) total += entry.items.length;
  }
  return total;
}

function formatSample(sample: Sample): string {
  const values = sample.msPerRun;
  const parts = [
    `median ${median(values).toFixed(1)}ms`,
    `min ${Math.min(...values).toFixed(1)}ms`,
    `max ${Math.max(...values).toFixed(1)}ms`,
  ];
  return `${sample.label.padEnd(34)} ${parts.join('  ')}${sample.detail ? `  (${sample.detail})` : ''}`;
}

function main(): void {
  const options = parseOptions(process.argv.slice(2));
  const importSamples: Sample[] = [];
  const openSamples: Sample[] = [];

  const { notifications, rawNotifications, source } = loadNotifications(options);

  measure(importSamples, '1. parse notifications', options.iterations, () =>
    rawNotifications.map((value) => parseSessionNotification(value))
  );

  measure(importSamples, '2. buildHistoryReplayImport', options.iterations, () =>
    buildHistoryReplayImport(notifications, {
      acpSessionId: 'bench-acp-session',
      provider: PROVIDER,
      userId: 'bench-user',
      now: () => '2026-01-01T00:00:00.000Z',
      createId: (() => {
        let id = 0;
        return () => `bench-tmp-${id++}`;
      })(),
      mode: 'imported_snapshot',
    })
  );

  const materialized: MaterializedReplay = measure(
    importSamples,
    '3. materializeReplay (2 + hash)',
    options.iterations,
    () =>
      materializeReplay({
        provider: PROVIDER,
        acpSessionId: ACP_SESSION_ID,
        replayNotifications: notifications,
        userId: 'bench-user',
        nowIso: '2026-01-01T00:00:00.000Z',
      })
  );

  const writtenDoc = measure(
    importSamples,
    '4. write history into LoroDoc',
    options.iterations,
    () => writeHistoryToDoc(materialized.history)
  );

  const exportedSnapshot = measure(
    importSamples,
    '5. export Loro snapshot',
    options.iterations,
    () => writtenDoc.export({ mode: 'snapshot' })
  );

  const realSnapshot =
    options.snapshotPath !== null
      ? new Uint8Array(readFileSync(expandHome(options.snapshotPath)))
      : options.repoPath !== null && options.sessionId !== null
        ? readSnapshotFromRepo(options.repoPath, options.sessionId)
        : null;
  const snapshot = realSnapshot ?? exportedSnapshot;
  const snapshotSource = realSnapshot
    ? `local session doc snapshot (${options.sessionId ?? options.snapshotPath})`
    : 'snapshot produced by phase 1';

  const importedDoc = measure(
    openSamples,
    '1. LoroDoc.import(snapshot)',
    options.iterations,
    () => {
      const doc = new LoroDoc();
      doc.import(snapshot);
      return doc;
    }
  );

  const mirror = measureWithSetup(
    openSamples,
    '2. new Mirror(sessionDocSchema)',
    options.iterations,
    () => {
      const doc = new LoroDoc();
      doc.import(snapshot);
      return doc;
    },
    (doc) =>
      new Mirror({
        doc,
        schema: sessionDocSchema,
        ignoreUnknownProperties: true,
        initialState: { session: { id: BENCH_SESSION_ID }, history: [] },
      })
  );

  const renderReady = measure(
    openSamples,
    '3. mirror.getState().history',
    options.iterations,
    () => (mirror.getState().history ?? []) as SessionHistoryInput[]
  );

  measure(openSamples, 'x. doc.toJSON() (comparison)', options.iterations, () =>
    importedDoc.toJSON()
  );

  const report = {
    source,
    snapshotSource,
    notifications: notifications.length,
    turns: materialized.history.length,
    messageItems: countItems(materialized.history),
    droppedNotifications: materialized.droppedNotifications,
    benchSnapshotBytes: exportedSnapshot.byteLength,
    measuredSnapshotBytes: snapshot.byteLength,
    renderReadyTurns: renderReady.length,
    renderReadyItems: countItems(renderReady as unknown as { items?: unknown }[]),
    iterations: options.iterations,
    import: importSamples.map((sample) => ({
      label: sample.label,
      medianMs: median(sample.msPerRun),
      msPerRun: sample.msPerRun,
    })),
    open: openSamples.map((sample) => ({
      label: sample.label,
      medianMs: median(sample.msPerRun),
      msPerRun: sample.msPerRun,
    })),
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  const lines = [
    'history import baseline',
    `  replay source        ${report.source}`,
    `  notifications        ${report.notifications}`,
    `  imported turns       ${report.turns} (${report.messageItems} message items)`,
    `  dropped              ${report.droppedNotifications}`,
    `  bench snapshot       ${(report.benchSnapshotBytes / 1024).toFixed(0)} KiB`,
    `  measured snapshot    ${(report.measuredSnapshotBytes / 1024).toFixed(0)} KiB — ${report.snapshotSource}`,
    `  render-ready turns   ${report.renderReadyTurns} (${report.renderReadyItems} message items)`,
    `  iterations           ${report.iterations}`,
    '',
    'phase 1 — import (replay -> history rows -> doc -> snapshot)',
    ...importSamples.map((sample) => `  ${formatSample(sample)}`),
    '',
    'phase 2 — open (snapshot -> render-ready history)',
    ...openSamples.map((sample) => `  ${formatSample(sample)}`),
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

main();

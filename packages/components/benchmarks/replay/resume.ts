/** Synthetic foreground catch-up. Measures the production reader, not DOM/paint. */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const root = resolve(process.argv[2] ?? '.');
const sourceHashes = Object.fromEntries(
  [
    'packages/shared/src/history-writer.ts',
    'packages/shared/src/session-data/loro.ts',
    'packages/components/src/lib/conversation-view/create-conversation-session.ts',
    'packages/components/src/lib/conversation-view/create-conversation-view-from-reader.ts',
    'pnpm-lock.yaml',
  ].map((file) => [
    file,
    createHash('sha256')
      .update(readFileSync(resolve(root, file)))
      .digest('hex'),
  ])
);
const runnerSha256 = createHash('sha256')
  .update(readFileSync(new URL(import.meta.url)))
  .digest('hex');
const { createHistoryWriter } = await import(
  pathToFileURL(resolve(root, 'packages/shared/src/history-writer.ts')).href
);
const { createLoroSessionData } = await import(
  pathToFileURL(resolve(root, 'packages/shared/src/session-data/loro.ts')).href
);
const { createConversationSession } = await import(
  pathToFileURL(
    resolve(root, 'packages/components/src/lib/conversation-view/create-conversation-session.ts')
  ).href
);
const { createRequire } = await import('node:module');
const require = createRequire(resolve(root, 'packages/components/package.json'));
const { LoroDoc, LoroMap, LoroText } = require('loro-crdt');
const source = new LoroDoc();
source.setPeerId('376');
const writer = createHistoryWriter(source);
let seed = 376;
const text = (length: number) =>
  Array.from({ length }, () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return String.fromCharCode(97 + ((seed >>> 0) % 26));
  }).join('');
const tools = Number(process.env.RESUME_TOOLS ?? 1200);
assert.ok(Number.isSafeInteger(tools) && tools > 0, 'RESUME_TOOLS must be a positive integer');
const updateKind = process.env.RESUME_UPDATE_KIND ?? 'text';
assert.ok(
  updateKind === 'text' || updateKind === 'append',
  'RESUME_UPDATE_KIND must be text or append'
);
writer.append({
  id: 'returning-turn',
  role: 'assistant',
  timestamp: '2026-01-01T00:00:00Z',
  items: [
    ...Array.from({ length: tools }, (_, i) => ({
      type: 'tool_call',
      toolCallId: `tool-${i}`,
      status: 'completed',
      kind: 'execute',
      title: `Synthetic result ${i}`,
      content: [{ type: 'content', content: { type: 'text', text: text(8192) } }],
    })),
    { type: 'text', text: '' },
  ],
});
source.getMap('session').set('id', 'resume-benchmark');
source.commit();
const snapshot = source.export({ mode: 'snapshot' });
const remote = source.fork();
remote.setPeerId('377');
const remoteItems = remote.getList('history').get(0).get('items');
const remoteText = remoteItems.get(tools).get('text');
const updates: Uint8Array[] = [];
let from = source.oplogVersion();
for (let i = 0; i < 30; i++) {
  if (updateKind === 'text') remoteText.insert(remoteText.length, `delta-${i} `);
  else {
    const item = remoteItems.insertContainer(remoteItems.length, new LoroMap());
    item.set('type', 'text');
    item.setContainer('text', new LoroText()).insert(0, `delta-${i} `);
  }
  remote.commit();
  updates.push(remote.export({ mode: 'update', from }));
  from = remote.oplogVersion();
}
remote.free();
source.free();

const doc = LoroDoc.fromSnapshot(snapshot);
const data = createLoroSessionData({ doc, sessionId: 'resume-benchmark' });
const readBody = data.history.readTurnForDisplay.bind(data.history);
const bodyReads: number[] = [];
data.history.readTurnForDisplay = (id: string) => {
  const start = performance.now();
  try {
    return readBody(id);
  } finally {
    bodyReads.push(performance.now() - start);
  }
};
const session = createConversationSession(doc, {
  sessionId: 'resume-benchmark',
  tailKeep: 0,
  scheduleIdle: (run: (deadline: { timeRemaining(): number }) => void) => {
    const id = setImmediate(() => run({ timeRemaining: () => 4 }));
    return () => clearImmediate(id);
  },
  createSessionData: () => data,
});
const view = session.history;
let range: ReturnType<typeof view.acquireRange> | undefined;
try {
  await view.ready;
  range = view.acquireRange(0, 1);
  await range.ready;
  assert.equal(view.turn(0)?.items.length, tools + 1);
  bodyReads.length = 0;
  const imports: number[] = [],
    updateTimes: number[] = [],
    taskDelays: number[] = [];
  for (let i = 0; i < updates.length; i++) {
    const expected =
      updateKind === 'text'
        ? Array.from({ length: i + 1 }, (_, j) => `delta-${j} `).join('')
        : `delta-${i} `;
    const changed = new Promise<void>((done) => {
      const off = view.subscribe(() => {
        if (view.turn(0)?.items.at(-1)?.text === expected) {
          off();
          done();
        }
      });
    });
    const start = performance.now();
    const task = new Promise<void>((done) =>
      setImmediate(() => {
        taskDelays.push(performance.now() - start);
        done();
      })
    );
    doc.import(updates[i]);
    imports.push(performance.now() - start);
    await changed;
    updateTimes.push(performance.now() - start);
    await task;
  }
  const summarize = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return {
      median: sorted[Math.floor(sorted.length / 2)],
      p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
      max: sorted.at(-1),
    };
  };
  console.log(
    JSON.stringify(
      {
        repository: root,
        sourceHashes,
        runnerSha256,
        tools,
        updateKind,
        updates: updates.length,
        node: process.version,
        fixtureSha256: createHash('sha256').update(snapshot).digest('hex'),
        snapshotBytes: snapshot.byteLength,
        bodyRead: summarize(bodyReads),
        import: summarize(imports),
        update: summarize(updateTimes),
        nextTask: summarize(taskDelays),
        complete: view.turn(0)?.items.at(-1)?.text.endsWith('delta-29 '),
        note: 'Node event-loop and reader workload; excludes browser rendering, layout and real network.',
      },
      null,
      2
    )
  );
} finally {
  range?.release();
  session.dispose();
  doc.free();
}

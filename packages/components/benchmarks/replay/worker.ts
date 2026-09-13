import assert from 'node:assert/strict';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { Session } from 'node:inspector';
import { LoroDoc, LoroList } from 'loro-crdt';
import { createHistoryWriter, type SessionId } from '@lody/shared';
import { createConversationSession } from '../../src/lib/conversation-view/create-conversation-session';

const config = JSON.parse(process.argv[2]!);
const immediate = () => new Promise<void>((resolve) => setImmediate(resolve));
const sessionId = 'benchmark-replay' as SessionId;
if (config.generate) {
  const doc = new LoroDoc();
  const writer = createHistoryWriter(doc);
  let seed = 376;
  const text = (n: number) =>
    Array.from({ length: n }, () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return String.fromCharCode(97 + ((seed >>> 0) % 26));
    }).join('');
  for (let i = 0; i < config.rounds; i++) {
    writer.append({
      id: `u${i}`,
      role: 'user',
      timestamp: '2026-01-01T00:00:00Z',
      items: [{ type: 'text', text: text(100) }],
    } as never);
    writer.append({
      id: `a${i}`,
      role: 'assistant',
      timestamp: '2026-01-01T00:00:01Z',
      finished: true,
      items: [
        { type: 'thought', text: text(256) },
        {
          type: 'tool_call',
          toolCallId: `tool${i}`,
          status: 'completed',
          kind: 'execute',
          title: 'Synthetic command',
          content: [{ type: 'content', content: { type: 'text', text: text(4096) } }],
        },
        { type: 'text', text: text(1024) },
      ],
    } as never);
  }
  fs.writeFileSync(config.fixture, doc.export({ mode: 'snapshot' }));
  doc.free();
  process.exit(0);
}
const bytes = new Uint8Array(fs.readFileSync(config.fixture)); // file IO outside the measured replay
const profiler = new Session();
const post = (method: string) =>
  new Promise<{ profile?: unknown }>((resolve, reject) =>
    profiler.post(method as never, (e, r) => (e ? reject(e) : resolve(r)))
  );
if (config.profile) {
  profiler.connect();
  await post('Profiler.enable');
  await post('Profiler.start');
}
const timings: Record<string, number> = {};
const cpuMs: Record<string, number> = {};
const phaseMemory: Record<string, ReturnType<typeof process.memoryUsage>> = {};
const chunks: number[] = [];
let phase = 'import';
const gets: Record<string, number> = {};
const originalGet = LoroList.prototype.get;
if (config.counters)
  LoroList.prototype.get = function (...args: Parameters<typeof originalGet>) {
    gets[phase] = (gets[phase] ?? 0) + 1;
    return originalGet.apply(this, args);
  };
const timed = async <T>(name: string, work: () => T | Promise<T>): Promise<T> => {
  phase = name;
  const t = performance.now();
  const cpu = process.cpuUsage();
  try {
    return await work();
  } finally {
    timings[name] = performance.now() - t;
    const used = process.cpuUsage(cpu);
    cpuMs[name] = (used.user + used.system) / 1000;
    phaseMemory[name] = process.memoryUsage();
  }
};
const queue: Array<{ active: boolean; run: () => void | Promise<void> }> = [];
const doc = new LoroDoc();
let session: ReturnType<typeof createConversationSession> | undefined;
let lease:
  | ReturnType<ReturnType<typeof createConversationSession>['history']['acquireRange']>
  | undefined;
try {
  await timed('import', () => doc.import(bytes));
  const expected = doc.getList('history').length;
  assert(expected > 0);
  doc.getMap('session').set('id', sessionId);
  if (config.mode === 'committed') doc.commit();
  const pendingAtOpen = doc.getPendingTxnLength();
  await timed('directory', async () => {
    session = createConversationSession(doc, {
      sessionId,
      scheduleIdle: (task) => {
        const job = {
          active: true,
          run: () => {
            const start = performance.now();
            return task({
              timeRemaining: () => Math.max(0, config.idleBudgetMs - (performance.now() - start)),
            });
          },
        };
        queue.push(job);
        return () => {
          job.active = false;
        };
      },
      yieldToEventLoop: immediate,
    });
    if (session.history.turnCount !== expected)
      await new Promise<void>((resolve) => {
        const off = session!.history.subscribe(() => {
          if (session!.history.turnCount === expected) {
            off();
            resolve();
          }
        });
      });
    assert.equal(session.history.turnCount, expected);
  });
  const view = session!.history;
  const checkWindow = (from: number, to: number) => {
    for (let i = from; i < to; i++) assert.equal(view.turn(i)?.id, view.index(i)?.id);
  };
  await timed('tail', async () => {
    lease = view.acquireRange(Math.max(0, expected - 30), expected);
    await lease.ready;
    checkWindow(Math.max(0, expected - 30), expected);
  });
  async function drain() {
    let jobs = 0;
    for (;;) {
      await immediate();
      const job = queue.shift();
      if (!job) break;
      if (!job.active) continue;
      assert(++jobs < 100000, 'idle scheduler failed to converge');
      const t = performance.now();
      await job.run();
      chunks.push(performance.now() - t);
    }
  }
  await timed('idleTail', async () => {
    await drain();
    await view.ready;
    if (expected > 40)
      assert.equal(view.index(0)?.summary, undefined, 'offscreen summary read eagerly');
  });
  await timed('outlinePreview', async () => {
    const preview = view.acquireRange(0, Math.min(2, expected));
    try {
      await preview.ready;
      assert(view.index(0)?.summary, 'requested preview did not fill');
    } finally {
      preview.release();
    }
  });
  await timed('windows', async () => {
    for (let i = 0; i < config.windows; i++) {
      const from = Math.floor(
        (expected - 1) * (i % 2 === 0 ? i / config.windows : 1 - i / config.windows)
      );
      const to = Math.min(expected, from + 30);
      const next = view.acquireRange(from, to);
      lease?.release();
      lease = next;
      await next.ready;
      checkWindow(from, to);
    }
  });
  await timed('append', async () => {
    const changed = new Promise<void>((resolve) => {
      const off = view.subscribe(() => {
        if (view.turnCount === expected + 1) {
          off();
          resolve();
        }
      });
    });
    session!.historyWriter.append({
      id: 'replay-stream',
      role: 'assistant',
      timestamp: '2026-01-01T00:00:00Z',
      items: [{ type: 'text', text: '' }],
    } as never);
    await changed;
    const next = view.acquireRange(expected, expected + 1);
    lease?.release();
    lease = next;
    await lease.ready;
    checkWindow(expected, expected + 1);
  });
  const streamTimes: number[] = [];
  await timed('stream', async () => {
    for (let i = 1; i <= config.tokens; i++) {
      const text = 'token '.repeat(i);
      const t = performance.now();
      const changed = new Promise<void>((resolve) => {
        const off = view.subscribe(() => {
          const item = view.turn(expected)?.items?.[0];
          if (item?.type === 'text' && item.text === text) {
            off();
            resolve();
          }
        });
      });
      assert(
        session!.historyWriter.updateEntry('replay-stream', (entry) => ({
          ...entry,
          items: [{ type: 'text', text }],
        }))
      );
      await changed;
      streamTimes.push(performance.now() - t);
    }
  });
  await timed('settle', drain);
  const hydrated = Array.from({ length: view.turnCount }, (_, i) => view.isHydrated(i)).filter(
    Boolean
  ).length;
  lease?.release();
  lease = undefined;
  session!.dispose();
  session = undefined;
  doc.free();
  global.gc?.();
  if (config.profile) {
    const result = await post('Profiler.stop');
    fs.writeFileSync(config.profile, JSON.stringify(result.profile));
    profiler.disconnect();
  }
  console.log(
    JSON.stringify({
      mode: config.mode,
      entries: expected,
      pendingAtOpen,
      timings,
      cpuMs,
      phaseMemory,
      idleChunks: chunks,
      streamTimes,
      hydrated,
      gets,
      memory: process.memoryUsage(),
      node: process.version,
    })
  );
} finally {
  LoroList.prototype.get = originalGet;
  if (session) {
    lease?.release();
    session.dispose();
    doc.free();
  }
}

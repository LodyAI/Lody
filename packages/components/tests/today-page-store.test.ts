import { LoroDoc } from 'loro-crdt';
import { describe, expect, it } from 'vitest';
import { getTodayDocId, parseTodayDate, type TodayDate } from '@lody/shared';
import { createTodayPageStore } from '../src/lib/today/today-page-store';
import { createTodayPageStoreCache } from '../src/providers/today-page-store-cache';

const date = parseTodayDate('2026-11-20') as TodayDate;
const docId = getTodayDocId('local:me', date);

/** Timers that run only when the test fires them. */
function manualTimers() {
  const pending = new Map<number, { callback: () => void; ms: number }>();
  let next = 0;
  return {
    setTimer: (callback: () => void, ms: number) => {
      const id = next++;
      pending.set(id, { callback, ms });
      return () => pending.delete(id);
    },
    delays: () => [...pending.values()].map((timer) => timer.ms),
    fireAll: () => {
      const due = [...pending.values()];
      pending.clear();
      for (const timer of due) timer.callback();
    },
  };
}

function harness(
  options: {
    registered?: boolean;
    failRegisterOnce?: boolean;
    /** Join outcomes in order; afterwards joins succeed and sync. */
    joins?: Array<'fail' | 'unsynced'>;
    /** Resolves the `synced` of an `unsynced` join (the room healed). */
    heal?: { promise: Promise<void> };
    doc?: LoroDoc;
  } = {}
) {
  const calls = { joins: 0, registrations: [] as unknown[], unsubscribed: 0 };
  let failRegister = options.failRegisterOnce ?? false;
  const outcomes = [...(options.joins ?? [])];
  const doc = options.doc ?? new LoroDoc();
  const timers = manualTimers();
  const store = createTodayPageStore({
    docId,
    doc,
    registered: options.registered ?? false,
    join: async () => {
      calls.joins += 1;
      const outcome = outcomes.shift();
      if (outcome === 'fail') throw new Error('join failed');
      return {
        room: { unsubscribe: () => void (calls.unsubscribed += 1) },
        synced:
          outcome === 'unsynced'
            ? (options.heal?.promise ?? new Promise<void>(() => {}))
            : Promise.resolve(),
      };
    },
    register: async (meta) => {
      if (failRegister) {
        failRegister = false;
        throw new Error('offline');
      }
      calls.registrations.push(meta);
    },
    // Only the retry backoff (a delay no other timer uses) is driven by the test.
    setTimer: (callback, ms) => (ms === RETRY_MS ? timers.setTimer(callback, ms) : () => {}),
    retryDelayMs: () => RETRY_MS,
  });
  return { doc, store, calls, timers };
}

const RETRY_MS = 7_321;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('Today page store', () => {
  it('opening an unregistered day for viewing neither joins nor registers', async () => {
    const { store, calls } = harness();
    expect(store.getSnapshot().isEmpty).toBe(true);
    await flush();
    expect(calls).toMatchObject({ joins: 0, registrations: [] });
  });

  it('the first local edit registers the page and joins its room', async () => {
    const { store, calls } = harness();
    store.outline.insertFirst('note');
    await flush();
    expect(calls.registrations).toEqual([{ userId: 'local:me', date: '2026-11-20' }]);
    expect(calls.joins).toBe(1);
    expect(store.getSnapshot().visible.map((node) => node.text)).toEqual(['note']);
  });

  it('a registered page joins immediately without registering again', async () => {
    const { calls } = harness({ registered: true });
    await flush();
    expect(calls).toMatchObject({ joins: 1, registrations: [] });
  });

  it('retries a failed registration on the next local edit', async () => {
    const { store, calls } = harness({ failRegisterOnce: true });
    const focus = store.outline.insertFirst('a') as { nodeId: never };
    await flush();
    expect(calls.registrations).toEqual([]);
    store.undo.editText(store.outline.getText(focus.nodeId)!, (text) => text.insert(1, 'b'));
    await flush();
    expect(calls.registrations).toHaveLength(1);
  });

  it('an empty line from clicking the placeholder does not create the page until something is typed', async () => {
    const { store, calls } = harness();
    const focus = store.outline.insertFirst('') as { nodeId: never };
    await flush();
    expect(calls).toMatchObject({ joins: 0, registrations: [] });
    store.undo.editText(store.outline.getText(focus.nodeId)!, (text) => text.insert(0, 'a'));
    await flush();
    expect(calls.registrations).toHaveLength(1);
  });

  it('releasing a page cancels its pending room join', async () => {
    const signals: AbortSignal[] = [];
    const store = createTodayPageStore({
      docId,
      doc: new LoroDoc(),
      registered: true,
      join: (signal) => {
        signals.push(signal);
        return new Promise(() => {});
      },
      register: async () => {},
      setTimer: () => () => {},
      retryDelayMs: () => 1000,
    });
    store.dispose();
    expect(signals.map((signal) => signal.aborted)).toEqual([true]);
  });

  it('retries a failed registration with backoff even when nothing more is typed', async () => {
    const { store, calls, timers } = harness({ failRegisterOnce: true });
    store.outline.insertFirst('a');
    await flush();
    expect(calls.registrations).toEqual([]);
    expect(timers.delays()).toEqual([RETRY_MS]);
    timers.fireAll();
    await flush();
    expect(calls.registrations).toHaveLength(1);
    expect(calls.joins).toBe(1);
  });

  it('registers a page reopened with local content that never got registered', async () => {
    const doc = new LoroDoc();
    harness({ doc, failRegisterOnce: true }).store.outline.insertFirst('kept locally');
    await flush();
    const reopened = harness({ doc });
    await flush();
    expect(reopened.calls.registrations).toEqual([{ userId: 'local:me', date: '2026-11-20' }]);
    expect(reopened.calls.joins).toBe(1);
  });

  it('retries a join that produced no room while the page stays open, without any edit', async () => {
    const { store, calls, timers } = harness({ registered: true, joins: ['fail', 'fail'] });
    let synced = false;
    void store.synced.then(() => (synced = true));
    await flush();
    expect(calls.joins).toBe(1);
    timers.fireAll();
    await flush();
    expect(calls.joins).toBe(2);
    timers.fireAll();
    await flush();
    expect(calls.joins).toBe(3);
    expect(synced).toBe(true);
    expect(timers.delays()).toEqual([]);
  });

  it('does not cut a failed join’s backoff short when the user types', async () => {
    const { store, calls, timers } = harness({ registered: true, joins: ['fail'] });
    await flush();
    const focus = store.outline.insertFirst('a') as { nodeId: never };
    store.undo.editText(store.outline.getText(focus.nodeId)!, (text) => text.insert(1, 'b'));
    await flush();
    expect(calls.joins).toBe(1);
    expect(timers.delays()).toEqual([RETRY_MS]);
    timers.fireAll();
    await flush();
    expect(calls.joins).toBe(2);
  });

  it('marks a room whose first sync failed as synced once it heals', async () => {
    let healed = () => {};
    const heal = { promise: new Promise<void>((resolve) => (healed = resolve)) };
    const { store } = harness({ registered: true, joins: ['unsynced'], heal });
    let synced = false;
    void store.synced.then(() => (synced = true));
    await flush();
    expect(synced).toBe(false);
    healed();
    await flush();
    expect(synced).toBe(true);
  });

  it('keeps a room whose first sync failed instead of joining again, and releases it on dispose', async () => {
    const { store, calls, timers } = harness({ registered: true, joins: ['unsynced'] });
    let synced = false;
    void store.synced.then(() => (synced = true));
    await flush();
    const focus = store.outline.insertFirst('a') as { nodeId: never };
    store.undo.editText(store.outline.getText(focus.nodeId)!, (text) => text.insert(1, 'b'));
    await flush();
    expect(calls.joins).toBe(1);
    expect(timers.delays()).toEqual([]);
    // Not synced: an empty-looking day is not skipped as empty.
    expect(synced).toBe(false);
    store.dispose();
    expect(calls.unsubscribed).toBe(1);
  });

  it('remote content arriving after a peer registered the page shows up in the snapshot', async () => {
    const { doc, store } = harness({ registered: true });
    const peer = new LoroDoc();
    const peerStore = createTodayPageStore({
      docId,
      doc: peer,
      registered: true,
      join: async () => ({ room: { unsubscribe: () => {} }, synced: true }),
      register: async () => {},
      setTimer: () => () => {},
      retryDelayMs: () => 1000,
    });
    peerStore.outline.insertFirst('from peer');
    doc.import(peer.export({ mode: 'update' }));
    expect(store.getSnapshot().visible.map((node) => node.text)).toEqual(['from peer']);
  });
});

describe('Today page store cache', () => {
  function cacheHarness(
    registeredIds: string[] = [],
    options: { failRegisteredCheck?: boolean } = {}
  ) {
    const opened: string[] = [];
    const unloaded: string[] = [];
    const meta = new Map<string, unknown>(registeredIds.map((id) => [id, {}]));
    let listener: ((event: { docId: string; exists: boolean }) => void) | undefined;
    const cache = createTodayPageStoreCache({
      repo: {
        openDoc: async (id) => {
          opened.push(id);
          return {
            doc: new LoroDoc(),
            joinRoom: async () => ({ room: { unsubscribe: () => {} }, synced: Promise.resolve() }),
          };
        },
        isRegistered: async (id) => {
          if (options.failRegisteredCheck) throw new Error('index unreadable');
          return meta.has(id);
        },
        upsertDocMeta: async (id, value) => {
          meta.set(id, value);
        },
        unloadDoc: async (id) => {
          unloaded.push(id);
        },
        observeDocs: (onEvent, query) => {
          listener = onEvent;
          return {
            docIds: [...meta.keys()].filter((id) => id.startsWith(query.prefix)),
            unsubscribe: () => {
              listener = undefined;
            },
          };
        },
      },
      releaseDelayMs: 60_000,
      idleCap: 1,
      setTimer: () => () => {},
      retryDelayMs: () => 1000,
    });
    return {
      cache,
      opened,
      unloaded,
      emit: (docId: string, exists = true) => listener?.({ docId, exists }),
    };
  }

  const day = (value: string) => getTodayDocId('u1', parseTodayDate(value) as TodayDate);

  it('lists only the exact member’s registered dates, newest first, and follows new registrations', () => {
    const h = cacheHarness([day('2026-11-18'), day('2026-11-20'), getTodayDocId('u1-x', date)]);
    const seen: string[][] = [];
    const stop = h.cache.observeDates('u1', (dates) => seen.push([...dates]));
    expect(seen.at(-1)).toEqual(['2026-11-20', '2026-11-18']);
    h.emit(day('2026-11-19'));
    expect(seen.at(-1)).toEqual(['2026-11-20', '2026-11-19', '2026-11-18']);
    // A deleted page leaves the index.
    h.emit(day('2026-11-20'), false);
    expect(seen.at(-1)).toEqual(['2026-11-19', '2026-11-18']);
    stop();
  });

  it('opens a page even when its registration cannot be checked', async () => {
    const h = cacheHarness([], { failRegisteredCheck: true });
    const page = await h.cache.acquire(day('2026-11-20'));
    expect(page.getSnapshot().isEmpty).toBe(true);
  });

  it('queues a page for eviction only when its last holder releases it', async () => {
    const h = cacheHarness();
    const held = day('2026-11-18');
    await h.cache.acquire(held);
    await h.cache.acquire(held);
    await h.cache.acquire(day('2026-11-19'));
    await h.cache.acquire(day('2026-11-20'));
    // One of two holders lets go: still in use, so it takes no idle slot.
    h.cache.releaseRef(held);
    h.cache.releaseRef(day('2026-11-19'));
    h.cache.releaseRef(day('2026-11-20'));
    await flush();
    expect(h.unloaded).toEqual([day('2026-11-19')]);
    expect(h.cache.peek(held)).toBeDefined();
  });

  it('evicts the oldest idle page beyond the cap and keeps pages still held', async () => {
    const h = cacheHarness();
    await h.cache.acquire(day('2026-11-18'));
    await h.cache.acquire(day('2026-11-19'));
    await h.cache.acquire(day('2026-11-20'));
    h.cache.releaseRef(day('2026-11-18'));
    h.cache.releaseRef(day('2026-11-19'));
    await flush();
    expect(h.unloaded).toEqual([day('2026-11-18')]);
    expect(h.cache.peek(day('2026-11-20'))).toBeDefined();
  });
});

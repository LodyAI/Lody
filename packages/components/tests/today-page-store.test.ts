import { LoroDoc } from 'loro-crdt';
import { describe, expect, it } from 'vitest';
import { getTodayDocId, parseTodayDate, type TodayDate } from '@lody/shared';
import { createTodayPageStore } from '../src/lib/today/today-page-store';
import { createTodayPageStoreCache } from '../src/providers/today-page-store-cache';

const date = parseTodayDate('2026-11-20') as TodayDate;
const docId = getTodayDocId('local:me', date);

function harness(options: { registered?: boolean; failRegisterOnce?: boolean } = {}) {
  const calls = { joins: 0, registrations: [] as unknown[] };
  let failRegister = options.failRegisterOnce ?? false;
  const doc = new LoroDoc();
  const store = createTodayPageStore({
    docId,
    doc,
    registered: options.registered ?? false,
    join: async () => {
      calls.joins += 1;
      return { unsubscribe: () => {} };
    },
    register: async (meta) => {
      if (failRegister) {
        failRegister = false;
        throw new Error('offline');
      }
      calls.registrations.push(meta);
    },
    setTimer: () => () => {},
  });
  return { doc, store, calls };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('Today page store', () => {
  it('opening an unregistered day for viewing neither joins nor registers', async () => {
    const { store, calls } = harness();
    expect(store.getSnapshot().isEmpty).toBe(true);
    await flush();
    expect(calls).toEqual({ joins: 0, registrations: [] });
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
    expect(calls).toEqual({ joins: 1, registrations: [] });
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
    expect(calls).toEqual({ joins: 0, registrations: [] });
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
    });
    store.dispose();
    expect(signals.map((signal) => signal.aborted)).toEqual([true]);
  });

  it('remote content arriving after a peer registered the page shows up in the snapshot', async () => {
    const { doc, store } = harness({ registered: true });
    const peer = new LoroDoc();
    const peerStore = createTodayPageStore({
      docId,
      doc: peer,
      registered: true,
      join: async () => ({ unsubscribe: () => {} }),
      register: async () => {},
      setTimer: () => () => {},
    });
    peerStore.outline.insertFirst('from peer');
    doc.import(peer.export({ mode: 'update' }));
    expect(store.getSnapshot().visible.map((node) => node.text)).toEqual(['from peer']);
  });
});

describe('Today page store cache', () => {
  function cacheHarness(registeredIds: string[] = []) {
    const opened: string[] = [];
    const unloaded: string[] = [];
    const meta = new Map<string, unknown>(registeredIds.map((id) => [id, {}]));
    let listener: ((event: { kind: string; docId: string }) => void) | undefined;
    const cache = createTodayPageStoreCache({
      repo: {
        openDoc: async (id) => {
          opened.push(id);
          return { doc: new LoroDoc(), joinRoom: async () => ({ unsubscribe: () => {} }) };
        },
        isRegistered: async (id) => meta.has(id),
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
    });
    return {
      cache,
      opened,
      unloaded,
      emit: (docId: string) => listener?.({ kind: 'doc-existence-changed', docId }),
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
    stop();
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

import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoroDoc, LoroMap } from 'loro-crdt';
import {
  createHistoryWriter,
  type SessionHistoryInput,
  type SessionId,
  type SessionMeta,
  type WorkspaceId,
} from '@lody/shared';
import { createLoroSessionData, type SessionHistoryReader } from '@lody/shared/session-data';
import { Writable } from 'node:stream';
import {
  WorkspaceSessionObserver,
  projectSessionCatalog,
  type WorkspaceObservedSession,
} from './session-observe-workspace';
import type { ObservedSession } from './session-observe';
import {
  SessionObserver,
  createSessionObserveWriter,
  resolveObserveSelection,
  type SessionObserveEvent,
} from './session-observe';

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const entry = (id: string, fields: Partial<SessionHistoryInput> = {}): SessionHistoryInput => ({
  id,
  role: 'user',
  timestamp: '2026-10-08T00:00:00.000Z',
  items: [],
  fileDiff: [],
  ...fields,
});

const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
});

async function fixture(
  history: SessionHistoryInput[],
  options: {
    reader?: (reader: SessionHistoryReader) => SessionHistoryReader;
    readMeta?: () => Promise<SessionMeta | null>;
    emit?: (event: SessionObserveEvent) => Promise<void>;
    start?: boolean;
  } = {}
) {
  const doc = new LoroDoc();
  const writer = createHistoryWriter(doc);
  history.forEach((turn) => writer.append(turn));
  const data = createLoroSessionData({ sessionId: 's' as SessionId, doc, writer });
  const meta: SessionMeta = {
    id: 's',
    machineId: 'm',
    userId: 'user',
    createdAt: 'synthetic',
    cliType: 'builtin',
    agentType: 'codex',
  };
  const events: SessionObserveEvent[] = [];
  const errors: unknown[] = [];
  const control = new Set<() => void>();
  const observer = new SessionObserver({
    sessionId: 's' as SessionId,
    history: options.reader?.(data.history) ?? data.history,
    readMeta: options.readMeta ?? (async () => meta),
    fresh: true,
    subscribeControl(listener) {
      control.add(listener);
      return () => {
        control.delete(listener);
      };
    },
    async emit(event) {
      events.push(event);
      await options.emit?.(event);
    },
    onError(error) {
      errors.push(error);
    },
  });
  disposals.push(async () => {
    await observer.close();
    data.dispose();
  });
  if (options.start !== false) await observer.start();
  return {
    doc,
    writer,
    data,
    observer,
    events,
    errors,
    meta,
    async update(id: string, fields: Partial<SessionHistoryInput>) {
      writer.updateEntry(id, (turn) => ({ ...turn, ...fields }));
      await observer.flush();
    },
    async metadata(fields: Partial<SessionMeta>) {
      Object.assign(meta, fields);
      control.forEach((notify) => notify());
      await observer.flush();
    },
  };
}

describe('Session observation', () => {
  it('recovers a fast completed turn in its initial snapshot without replaying a completion event', async () => {
    const f = await fixture([
      entry('u', { status: 'handled' }),
      entry('a', {
        role: 'assistant',
        userTurnId: 'u',
        finished: true,
        endedAt: Date.parse('2026-10-08T00:00:01.000Z'),
      }),
    ]);
    expect(f.events).toEqual([
      {
        type: 'snapshot',
        sessionId: 's',
        session: {
          sessionId: 's',
          machineId: 'm',
          archived: false,
          state: 'idle',
          source: 'persisted',
          freshness: 'synced',
          activeTurns: [],
          latestTurn: {
            userTurnId: 'u',
            assistantTurnId: 'a',
            state: 'completed',
            durationMs: 1000,
          },
        },
      },
    ]);
  });

  it('removes deleted tail rows and restores the previous latest turn', async () => {
    const f = await fixture([
      entry('old', { status: 'canceled' }),
      entry('u', { status: 'processing' }),
      entry('a', { role: 'assistant', userTurnId: 'u' }),
    ]);
    f.writer.update((history) => history.slice(0, 1));
    await f.observer.flush();
    expect(f.observer.current?.latestTurn).toEqual({ userTurnId: 'old', state: 'canceled' });
    expect(f.observer.current?.activeTurns).toEqual([]);
    f.writer.update(() => []);
    await f.observer.flush();
    expect(f.observer.current?.latestTurn).toBeUndefined();
    expect(f.observer.current?.state).toBe('idle');
    expect(f.events.filter((event) => event.type === 'turn.finished')).toEqual([]);
  });

  it('uses the first duplicate User and recovers retained copies after structural deletion', async () => {
    const f = await fixture([
      entry('u', { status: 'handled' }),
      entry('a', { role: 'assistant', userTurnId: 'u', finished: true }),
      entry('u', { status: 'processing' }),
    ]);
    expect(f.observer.current?.latestTurn?.state).toBe('completed');
    f.writer.update((history) => history.slice(0, 2));
    await f.observer.flush();
    expect(f.observer.current?.latestTurn?.state).toBe('completed');
    f.writer.update((history) => [history[0]!, history[0]!, history[1]!]);
    await f.observer.flush();
    expect(f.observer.current?.latestTurn?.state).toBe('completed');
    f.writer.update((history) => history.slice(1));
    await f.observer.flush();
    expect(f.observer.current?.latestTurn?.state).toBe('completed');
    expect(f.events.filter((event) => event.type === 'turn.finished')).toEqual([]);
  });

  it('waits for durable User and Assistant evidence even when metadata becomes idle first', async () => {
    const f = await fixture([
      entry('u', { status: 'processing' }),
      entry('a', { role: 'assistant', userTurnId: 'u', finished: false }),
    ]);
    await f.metadata({ status: { type: 'idle' } });
    await f.update('a', { finished: true });
    expect(f.events.filter((event) => event.type === 'turn.finished')).toEqual([]);
    await f.update('u', { status: 'handled' });
    expect(f.events.filter((event) => event.type === 'turn.finished')).toEqual([
      {
        type: 'turn.finished',
        sessionId: 's',
        userTurnId: 'u',
        assistantTurnId: 'a',
        outcome: 'completed',
        durationMs: 0,
      },
    ]);
    expect(f.observer.current?.state).toBe('idle');
  });

  it('continues across turns, including failure and cancellation without an Assistant', async () => {
    const f = await fixture([]);
    f.writer.append(entry('u1', { status: 'processing' }));
    await f.observer.flush();
    f.writer.append(entry('u2', { status: 'pending' }));
    f.writer.updateEntry('u1', (turn) => ({ ...turn, status: 'failed' }));
    f.writer.updateEntry('u2', (turn) => ({ ...turn, status: 'canceled' }));
    await f.observer.flush();
    expect(
      f.events.filter((event) => event.type === 'turn.started' || event.type === 'turn.finished')
    ).toEqual([
      { type: 'turn.started', sessionId: 's', userTurnId: 'u1' },
      { type: 'turn.finished', sessionId: 's', userTurnId: 'u1', outcome: 'failed' },
      { type: 'turn.finished', sessionId: 's', userTurnId: 'u2', outcome: 'canceled' },
    ]);
    expect(f.errors).toEqual([]);
  });

  it('does not hydrate bodies or rescan a long transcript for streaming updates', async () => {
    const f = await fixture([
      ...Array.from({ length: 100 }, (_, i) =>
        entry(`old-${i}`, {
          status: 'canceled',
          items: [{ type: 'text', text: 'large'.repeat(1000) }],
        })
      ),
      entry('u', { status: 'processing' }),
      entry('a', { role: 'assistant', userTurnId: 'u', finished: false }),
    ]);
    const serialize = vi.spyOn(LoroMap.prototype, 'toJSON');
    const readDirectory = vi.spyOn(f.data.history, 'readDirectory');
    try {
      const before = f.events.length;
      for (let i = 0; i < 30; i++) {
        const assistant = f.doc.getList('history').get(101);
        if (!(assistant instanceof LoroMap)) throw new Error('Missing assistant');
        assistant.set('items', [{ type: 'text', text: String(i) }]);
        f.doc.commit();
      }
      await f.observer.flush();
      expect(f.events).toHaveLength(before);
      expect(serialize).not.toHaveBeenCalled();
      expect(readDirectory.mock.calls.length).toBeGreaterThan(0);
      expect(readDirectory.mock.calls.every(([from, to]) => from === 101 && to === 102)).toBe(true);
    } finally {
      serialize.mockRestore();
      readDirectory.mockRestore();
    }
  });

  it('reconciles results after connection loss without reporting presence loss as completion', async () => {
    const f = await fixture([
      entry('u', { status: 'processing' }),
      entry('a', { role: 'assistant', userTurnId: 'u' }),
    ]);
    f.observer.setFreshness(false);
    await f.observer.flush();
    await f.update('u', { status: 'handled' });
    await f.update('a', { finished: true });
    expect(f.observer.current?.freshness).toBe('unavailable');
    expect(f.observer.current?.state).toBe('running');
    expect(f.events.filter((e) => e.type === 'turn.finished')).toEqual([]);
    f.observer.setFreshness(true);
    await f.observer.flush();
    expect(f.events.filter((e) => e.type === 'turn.finished')).toHaveLength(1);
    expect(f.observer.current?.latestTurn?.state).toBe('completed');
  });

  it('retires turns deleted while stale after confirmed catch-up', async () => {
    const f = await fixture([
      entry('u', { status: 'processing' }),
      entry('a', { role: 'assistant', userTurnId: 'u' }),
    ]);
    f.observer.setFreshness(false);
    await f.observer.flush();
    f.writer.update(() => []);
    await f.observer.flush();
    expect(f.observer.current?.activeTurns).toHaveLength(1);
    f.observer.setFreshness(true);
    await f.observer.flush();
    expect(f.observer.current).toMatchObject({
      state: 'idle',
      activeTurns: [],
      freshness: 'synced',
    });
    expect(f.observer.current?.latestTurn).toBeUndefined();
    expect(f.events.filter((event) => event.type === 'turn.finished')).toEqual([]);
  });

  it('handles a reopened Assistant and a second completion under the same identities', async () => {
    const f = await fixture([
      entry('u', { status: 'handled' }),
      entry('a', { role: 'assistant', userTurnId: 'u', finished: true }),
    ]);
    await f.update('a', { finished: false });
    await f.update('a', { finished: true });
    expect(
      f.events
        .filter((e) => e.type === 'turn.started' || e.type === 'turn.finished')
        .map((e) => e.type)
    ).toEqual(['turn.started', 'turn.finished']);
  });

  it('captures a change arriving while the initial directory is delayed', async () => {
    const gate = deferred<void>();
    const f = await fixture([entry('u', { status: 'pending' })], {
      start: false,
      reader(reader) {
        return {
          ...reader,
          observe(listener) {
            const observation = reader.observe(listener);
            return {
              ...observation,
              initial: observation.initial.then(async (rows) => {
                await gate.promise;
                return rows;
              }),
            };
          },
        };
      },
    });
    const start = f.observer.start();
    f.writer.updateEntry('u', (turn) => ({ ...turn, status: 'failed' }));
    gate.resolve();
    await start;
    expect(f.observer.current?.latestTurn?.state).toBe('failed');
    expect(f.events.map((e) => e.type)).toEqual(['snapshot']);
  });

  it('fences a delayed stale read when the same turn changes again', async () => {
    const captured = deferred<void>();
    const gate = deferred<void>();
    let delay = false;
    const f = await fixture([entry('u', { status: 'pending' })], {
      reader(reader) {
        return {
          ...reader,
          async readDirectory(from, to) {
            const rows = await reader.readDirectory(from, to);
            if (delay) {
              delay = false;
              captured.resolve();
              await gate.promise;
            }
            return rows;
          },
        };
      },
    });
    delay = true;
    f.writer.updateEntry('u', (turn) => ({ ...turn, status: 'processing' }));
    await captured.promise;
    f.writer.updateEntry('u', (turn) => ({ ...turn, status: 'canceled' }));
    gate.resolve();
    await f.observer.flush();
    expect(f.events.filter((e) => e.type === 'turn.started')).toEqual([]);
    expect(f.observer.current?.latestTurn?.state).toBe('canceled');
  });

  it('preserves stored history and stops emitting after disposal', async () => {
    const f = await fixture([entry('u', { status: 'pending', read: false })]);
    const before = f.doc.toJSON();
    await f.observer.close();
    expect(f.doc.toJSON()).toEqual(before);
    const count = f.events.length;
    f.writer.updateEntry('u', (turn) => ({ ...turn, status: 'processing' }));
    await f.observer.flush();
    expect(f.events).toHaveLength(count);
    expect((await f.data.history.readTurn('u')).state).toBe('ready');
  });

  it('distinguishes archive changes from a definitive deletion', async () => {
    let removed = false;
    const meta: SessionMeta = {
      id: 's',
      machineId: 'm',
      createdAt: 'synthetic',
      userId: 'user',
      cliType: 'builtin',
      agentType: 'codex',
    };
    const f = await fixture([], { readMeta: async () => (removed ? null : meta) });
    meta.isArchived = true;
    f.observer.refresh();
    await f.observer.flush();
    expect(f.observer.current?.archived).toBe(true);
    expect(f.events.at(-1)?.type).toBe('session.changed');
    removed = true;
    f.observer.refresh();
    await f.observer.flush();
    expect(f.events.at(-1)).toEqual({ type: 'session.removed', sessionId: 's' });
  });
});

describe('Session observation process boundary', () => {
  it('validates scope and streaming flags before authentication or writes', () => {
    expect(resolveObserveSelection(undefined, {}, 's')).toEqual({ all: false, sessionId: 's' });
    expect(
      resolveObserveSelection(
        undefined,
        { all: true, workspace: 'w', jsonl: true, follow: true },
        'ignored'
      )
    ).toEqual({ all: true });
    expect(() => resolveObserveSelection('s', { follow: true })).toThrow('--jsonl');
    expect(() => resolveObserveSelection('s', { json: true, jsonl: true })).toThrow('either');
    expect(() => resolveObserveSelection('s', { all: true, workspace: 'w' })).toThrow('not both');
    expect(() => resolveObserveSelection(undefined, { all: true })).toThrow('--workspace');
    expect(() =>
      resolveObserveSelection('s', { follow: true, jsonl: true, offline: true })
    ).toThrow('--offline');
  });

  it('orders multiple producers and waits for output backpressure', async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const lines: string[] = [];
    const output = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        if (lines.length === 1) {
          entered.resolve();
          void release.promise.then(() => done());
        } else done();
      },
    });
    const stop = new AbortController();
    const write = createSessionObserveWriter({
      output,
      streamId: 'stream',
      workspaceId: 'w' as WorkspaceId,
      now: () => 100,
      signal: stop.signal,
    });
    const first = write({ type: 'ready' });
    await entered.promise;
    const second = write({ type: 'ready', sessionId: 's' as SessionId });
    expect(lines).toHaveLength(1);
    release.resolve();
    await Promise.all([first, second]);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      {
        type: 'ready',
        version: 1,
        streamId: 'stream',
        workspaceId: 'w',
        sequence: 1,
        observedAt: 100,
      },
      {
        type: 'ready',
        sessionId: 's',
        version: 1,
        streamId: 'stream',
        workspaceId: 'w',
        sequence: 2,
        observedAt: 100,
      },
    ]);
  });

  it('releases a pending write on shutdown and rejects an oversized frame', async () => {
    const entered = deferred<void>();
    const output = new Writable({
      write(_chunk, _encoding, _done) {
        entered.resolve();
      },
    });
    const stop = new AbortController();
    const write = createSessionObserveWriter({
      output,
      streamId: 'stream',
      workspaceId: 'w' as WorkspaceId,
      now: () => 100,
      signal: stop.signal,
    });
    const pending = write({ type: 'ready' });
    const rejected = expect(pending).rejects.toThrow('stopped');
    await entered.promise;
    await expect(write({ type: 'error', error: 'x'.repeat(1024 * 1024) })).rejects.toThrow('1 MiB');
    stop.abort();
    await rejected;
    expect(output.listenerCount('error')).toBe(0);
  });

  it('handles a broken pipe including the error event after its write callback', async () => {
    const failed = deferred<void>();
    const output = new Writable({
      write(_chunk, _encoding, done) {
        done(new Error('EPIPE'));
      },
    });
    output.once('close', () => failed.resolve());
    const write = createSessionObserveWriter({
      output,
      streamId: 'stream',
      workspaceId: 'w' as WorkspaceId,
      now: () => 100,
      signal: new AbortController().signal,
    });
    await expect(write({ type: 'ready' })).rejects.toThrow('EPIPE');
    await failed.promise;
    expect(output.listenerCount('error')).toBe(0);
  });
});

describe('Workspace Session observation', () => {
  const meta = (id: string, fields: Partial<SessionMeta> = {}): SessionMeta => ({
    id,
    machineId: 'm',
    userId: 'user',
    createdAt: 'synthetic',
    cliType: 'builtin',
    agentType: 'codex',
    ...fields,
  });

  function workspaceFixture(
    rows: SessionMeta[],
    options: {
      list?: () => Promise<SessionMeta[]>;
      open?: (
        id: SessionId,
        emit: (event: SessionObserveEvent) => Promise<void>
      ) => Promise<WorkspaceObservedSession>;
      follow?: boolean;
    } = {}
  ) {
    const catalog = new Map(rows.map((row) => [row.id as SessionId, row]));
    const events: SessionObserveEvent[] = [];
    const opened = new Map<
      SessionId,
      { current: ObservedSession; emit: (event: SessionObserveEvent) => Promise<void> }
    >();
    const held = new Set<SessionId>();
    const errors: unknown[] = [];
    const reader = new WorkspaceSessionObserver({
      listMetas: options.list ?? (async () => [...catalog.values()]),
      readMeta: async (id) => catalog.get(id) ?? null,
      async open(id, emit) {
        if (options.open) return options.open(id, emit);
        const row = catalog.get(id);
        if (!row) throw new Error('Missing catalog row');
        const current: ObservedSession = {
          ...projectSessionCatalog(row),
          source: 'persisted',
          state: 'running',
        };
        const item = { current, emit };
        opened.set(id, item);
        held.add(id);
        await emit({ type: 'snapshot', sessionId: id, session: current });
        return {
          observer: {
            get current() {
              return item.current;
            },
            refresh() {},
            async flush() {},
          },
          async close() {
            held.delete(id);
          },
        };
      },
      async emit(event) {
        events.push(event);
      },
      onError(error) {
        errors.push(error);
      },
      follow: options.follow !== false,
    });
    disposals.push(() => reader.close());
    return { reader, catalog, events, opened, held, errors };
  }

  it('keeps idle history rooms unopened and releases active rooms only after durable completion', async () => {
    const f = workspaceFixture([
      ...Array.from({ length: 1000 }, (_, i) =>
        meta(`old-${i}`, {
          status: { type: 'idle' },
          latestUserMsgId: `old-u-${i}`,
          lastHandledUserMsgId: `old-u-${i}`,
        })
      ),
      meta('active', { processingUserMsgId: 'u', status: { type: 'running' } }),
    ]);
    await f.reader.start();
    await f.reader.flush();
    expect(f.reader.current).toHaveLength(1001);
    expect([...f.held]).toEqual(['active']);
    expect(f.reader.current.find((s) => s.sessionId === 'old-0')?.source).toBe('metadata');
    const row = f.catalog.get('active' as SessionId);
    if (!row) throw new Error('Missing active row');
    row.status = { type: 'idle' };
    f.reader.refresh('active' as SessionId);
    await f.reader.flush();
    expect(f.held.has('active' as SessionId)).toBe(true);
    const child = f.opened.get('active' as SessionId);
    if (!child) throw new Error('Missing active observer');
    child.current = {
      ...child.current,
      state: 'idle',
      latestTurn: { userTurnId: 'u', state: 'completed' },
    };
    await child.emit({
      type: 'turn.finished',
      sessionId: 'active' as SessionId,
      userTurnId: 'u',
      outcome: 'completed',
    });
    await child.emit({
      type: 'session.changed',
      sessionId: 'active' as SessionId,
      session: child.current,
    });
    await f.reader.flush();
    expect(f.held.size).toBe(0);
    expect(f.reader.current.find((s) => s.sessionId === 'active')?.latestTurn?.state).toBe(
      'completed'
    );
    expect(f.errors).toEqual([]);
  });

  it('captures catalog changes during initial enumeration and follows subsequent creation/deletion', async () => {
    const gate = deferred<void>();
    const f = workspaceFixture([meta('one')], {
      list: async () => {
        await gate.promise;
        return [meta('one')];
      },
    });
    const start = f.reader.start();
    f.catalog.set('two' as SessionId, meta('two'));
    f.reader.refresh('two' as SessionId);
    gate.resolve();
    await start;
    await f.reader.flush();
    const ready = f.events.findIndex((e) => e.type === 'ready');
    expect(f.events.slice(0, ready).some((e) => 'sessionId' in e && e.sessionId === 'two')).toBe(
      true
    );
    expect(f.held.has('two' as SessionId)).toBe(true);
    f.catalog.delete('two' as SessionId);
    f.reader.refresh('two' as SessionId);
    await f.reader.flush();
    expect(f.events.filter((e) => e.type === 'session.removed')).toEqual([
      { type: 'session.removed', sessionId: 'two' },
    ]);
    expect(f.held.has('two' as SessionId)).toBe(false);
    expect(f.reader.current.map((s) => s.sessionId)).toEqual(['one']);
  });

  it('opens at most four rooms concurrently and closes a room acquired during shutdown', async () => {
    const fourOpened = deferred<void>();
    const gate = deferred<void>();
    let acquired = 0;
    const held = new Set<SessionId>();
    const f = workspaceFixture(
      Array.from({ length: 10 }, (_, i) => meta(`s-${i}`, { status: { type: 'running' } })),
      {
        async open(id) {
          acquired += 1;
          if (acquired === 4) fourOpened.resolve();
          await gate.promise;
          held.add(id);
          return {
            observer: {
              current: {
                ...projectSessionCatalog(meta(id)),
                source: 'persisted',
                state: 'running',
              },
              refresh() {},
              async flush() {},
            },
            async close() {
              held.delete(id);
            },
          };
        },
      }
    );
    await f.reader.start();
    await fourOpened.promise;
    expect(acquired).toBe(4);
    const closed = f.reader.close();
    gate.resolve();
    await closed;
    expect(acquired).toBe(4);
    expect(held.size).toBe(0);
  });

  it('reads catalog snapshots without acquiring rooms in one-shot mode', async () => {
    const f = workspaceFixture([meta('running', { status: { type: 'running' } })], {
      follow: false,
    });
    await f.reader.start();
    await f.reader.flush();
    expect(f.reader.current[0]).toMatchObject({
      sessionId: 'running',
      source: 'metadata',
      state: 'unknown',
    });
    expect(f.opened.size).toBe(0);
    expect(f.events.map((e) => e.type)).toEqual(['snapshot', 'ready']);
  });
});

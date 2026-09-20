import { describe, expect, it, vi } from 'vitest';
import { LoroDoc, LoroMap, LoroList, LoroText } from 'loro-crdt';
import type { LoroRepo } from 'loro-repo';
import { SessionDocument } from './doc';
import type { Logger } from '@/utils/logger';
import {
  createSessionMirror,
  type SessionHistoryInput,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import { createLoroSessionData, type SessionTurn } from '@lody/shared/session-data';
import {
  attachSessionModelSummary,
  latestSessionModel,
  latestSessionModelFromReader,
} from './session-model-summary';

const assistant = (
  id: string,
  modelInfo?: SessionHistoryInput['modelInfo'],
  items: SessionHistoryInput['items'] = [{ type: 'text', text: 'hi' }]
): SessionHistoryInput => ({
  id,
  role: 'assistant',
  timestamp: '2026-09-12T00:00:00Z',
  items,
  modelInfo,
});

const sourceFromMirror = (mirror: ReturnType<typeof createSessionMirror>) => ({
  subscribe: (listener: () => void) => mirror.subscribe(listener),
  latestModel: () => latestSessionModel(mirror.getState().history ?? []),
});

describe('session model summary', () => {
  it('publishes through SessionDocument but never creates hidden or deleted catalog rows', async () => {
    for (const initial of [
      undefined,
      { meta: { id: 'model-test' }, deleted: true },
      { meta: { id: 'model-test' } },
    ]) {
      let stored = initial;
      const raw = new LoroDoc();
      const repo = {
        openPersistedDoc: async () => ({ doc: raw }),
        getDocMeta: async () => stored,
        upsertDocMeta: async (_id: string, patch: Partial<SessionMeta>) => {
          stored = { ...stored, meta: { ...stored?.meta, ...patch } };
        },
      } as unknown as LoroRepo;
      const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
      const doc = new SessionDocument(repo, 'model-test' as SessionId, async () => {}, logger);
      await doc.initOffline();
      await doc.sessionData.commands.appendTurn(
        assistant('a1', { modelId: 'actual', name: 'Actual' }) as SessionTurn
      );
      await doc.destroy({ preserveStatus: true });
      if (!initial || initial.deleted) expect(stored).toEqual(initial);
      else
        expect(stored?.meta).toEqual({
          id: 'model-test',
          lastModel: { modelId: 'actual', name: 'Actual' },
        });
    }
  });
  it.each(['history', 'destroy'] as const)(
    'repairs external metadata overwrite on %s',
    async (trigger) => {
      let stored = { meta: { id: 'repair', lastModel: { modelId: 'stale' } } };
      const writes: unknown[] = [];
      const raw = new LoroDoc();
      const repo = {
        openPersistedDoc: async () => ({ doc: raw }),
        getDocMeta: async () => stored,
        upsertDocMeta: async (_id: string, patch: object) => {
          writes.push(patch);
          stored = { meta: { ...stored.meta, ...patch } };
        },
      } as unknown as LoroRepo;
      const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
      const doc = new SessionDocument(repo, 'repair' as SessionId, async () => {}, logger);
      await doc.initOffline();
      await doc.sessionData.commands.appendTurn(
        assistant('a', { modelId: 'actual', name: '' }) as SessionTurn
      );
      await doc.syncModelSummary();
      expect(stored.meta.lastModel).toEqual({ modelId: 'actual' });
      await doc.syncModelSummary();
      expect(writes).toHaveLength(1);
      stored = { meta: { ...stored.meta, lastModel: { modelId: 'stale' } } };
      if (trigger === 'history') {
        const repaired = Promise.withResolvers<void>();
        const upsert = repo.upsertDocMeta.bind(repo);
        repo.upsertDocMeta = async (...args) => {
          await upsert(...args);
          repaired.resolve();
        };
        doc.sessionData.writer.setField('a', 'finished', true);
        raw.commit();
        await repaired.promise;
        expect(stored.meta.lastModel).toEqual({ modelId: 'actual' });
      }
      await doc.destroy({ preserveStatus: true });
      expect(stored.meta.lastModel).toEqual({ modelId: 'actual' });
      expect(writes).toHaveLength(2);
    }
  );

  it('reads container and legacy summaries without serializing bodies or provider metadata', () => {
    const raw = new LoroDoc();
    const list = raw.getList('history');
    list.insert(0, assistant('legacy', { modelId: 'legacy', name: 'Legacy' }));
    const turn = list.insertContainer(1, new LoroMap());
    turn.set('role', 'assistant');
    const model = turn.setContainer('modelInfo', new LoroMap());
    model.setContainer('modelId', new LoroText()).insert(0, ' actual ');
    model.set('name', ' Actual ');
    model.setContainer('_meta', new LoroMap()).set('opaque', 'x'.repeat(100_000));
    const items = turn.setContainer('items', new LoroList());
    const data = createLoroSessionData({ doc: raw, sessionId: 'shallow' as SessionId });
    const mapJSON = vi.spyOn(LoroMap.prototype, 'toJSON').mockImplementation(() => {
      throw new Error('body materialized');
    });
    const listJSON = vi.spyOn(LoroList.prototype, 'toJSON').mockImplementation(() => {
      throw new Error('list materialized');
    });
    try {
      expect(latestSessionModelFromReader(data.history)).toEqual({
        modelId: 'legacy',
        name: 'Legacy',
      });
      items.insert(0, { type: 'future_tool', payload: 'x'.repeat(100_000) });
      raw.commit();
      expect(latestSessionModelFromReader(data.history)).toEqual({
        modelId: 'actual',
        name: 'Actual',
      });
      items.delete(0, 1);
      turn.setContainer('plan', new LoroList()).insert(0, { content: 'step' });
      expect(latestSessionModelFromReader(data.history)).toEqual({
        modelId: 'actual',
        name: 'Actual',
      });
      model.delete('modelId');
      model.delete('name');
      expect(latestSessionModelFromReader(data.history)).toEqual({});
      list.delete(0, 2);
      list.insert(0, 'invalid');
      expect(latestSessionModelFromReader(data.history)).toBeNull();
    } finally {
      mapJSON.mockRestore();
      listJSON.mockRestore();
      data.dispose();
    }
  });

  it('uses actual latest assistant data, never requested config or an older known model', () => {
    const first = assistant('a1', { modelId: 'actual', name: 'Actual', _meta: { secret: 'omit' } });
    expect(latestSessionModel([first])).toEqual({ modelId: 'actual', name: 'Actual' });
    expect(
      latestSessionModel([
        first,
        { id: 'u2', role: 'user', timestamp: first.timestamp, inputConfig: { modelId: 'next' } },
      ])
    ).toEqual({ modelId: 'actual', name: 'Actual' });
    expect(latestSessionModel([first, assistant('a2')])).toEqual({});
    expect(latestSessionModel([])).toBeNull();
  });

  it('ignores assistant entries the renderer hides: no items and no plan', () => {
    const shown = assistant('a1', { modelId: 'shown', name: 'Shown' });
    const empty = assistant('a2', { modelId: 'empty', name: 'Empty' }, []);
    expect(latestSessionModel([shown, empty])).toEqual({ modelId: 'shown', name: 'Shown' });
    expect(latestSessionModel([empty])).toBeNull();
    expect(
      latestSessionModel([
        shown,
        { ...empty, plan: [{ content: 'step', status: 'pending', priority: 'medium' }] },
      ])
    ).toEqual({ modelId: 'empty', name: 'Empty' });
  });

  it('publishes a fork target once its catalog row becomes visible', async () => {
    let stored: { meta: Partial<SessionMeta> } | undefined;
    const raw = new LoroDoc();
    const repo = {
      openPersistedDoc: async () => ({ doc: raw }),
      getDocMeta: async () => stored,
      upsertDocMeta: async (_id: string, patch: Partial<SessionMeta>) => {
        stored = { meta: { ...stored?.meta, ...patch } };
      },
    } as unknown as LoroRepo;
    const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
    const doc = new SessionDocument(repo, 'fork-target' as SessionId, async () => {}, logger);
    await doc.initOffline();
    await doc.sessionData.commands.appendTurn(
      assistant('a1', { modelId: 'forked', name: 'Forked' }) as SessionTurn
    );
    await doc.syncModelSummary();
    expect(stored).toBeUndefined();
    await repo.upsertDocMeta('fork-target', { id: 'fork-target' } as SessionMeta);
    await doc.syncModelSummary();
    expect(stored?.meta).toEqual({
      id: 'fork-target',
      lastModel: { modelId: 'forked', name: 'Forked' },
    });
    await doc.destroy({ preserveStatus: true });
  });

  it('projects real history writes, coalesces streaming, handles rewind and stops on disposal', async () => {
    const mirror = createSessionMirror({
      doc: new LoroDoc(),
      initialState: { session: { id: 'model-test' as SessionId }, history: [] },
    });
    const writes: SessionMeta['lastModel'][] = [];
    const errors: unknown[] = [];
    const handle = attachSessionModelSummary(
      sourceFromMirror(mirror),
      async (model) => {
        if (JSON.stringify(writes.at(-1)) !== JSON.stringify(model)) writes.push(model);
        return true;
      },
      (error) => errors.push(error)
    );
    mirror.historyWriter.update(() => [assistant('a1', { modelId: 'one', name: 'One' })]);
    await handle.flush();
    mirror.historyWriter.updateEntry('a1', (entry) => ({ ...entry, finished: true }));
    await handle.flush();
    expect(writes).toEqual([{ modelId: 'one', name: 'One' }]);
    mirror.historyWriter.update((history) => [
      ...history,
      assistant('a2', { modelId: 'two', name: '' }),
    ]);
    await handle.flush();
    mirror.historyWriter.setField('a1', 'modelInfo', { modelId: 'late-old-model', name: '' });
    await handle.flush();
    expect(writes.at(-1)).toEqual({ modelId: 'two' });
    mirror.historyWriter.update((history) => history.slice(0, 1));
    await handle.flush();
    expect(writes.at(-1)).toEqual({ modelId: 'late-old-model' });
    handle.dispose();
    mirror.historyWriter.update(() => []);
    await handle.flush();
    expect(writes.at(-1)).toEqual({ modelId: 'late-old-model' });
    expect(errors).toEqual([]);
    mirror.dispose();
  });

  it('serializes model changes during publication and retries a failed write', async () => {
    const mirror = createSessionMirror({
      doc: new LoroDoc(),
      initialState: { session: { id: 'model-test' as SessionId }, history: [] },
    });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const writes: SessionMeta['lastModel'][] = [];
    const errors: unknown[] = [];
    let fail = false;
    const handle = attachSessionModelSummary(
      sourceFromMirror(mirror),
      async (model) => {
        if (!writes.length) {
          entered.resolve();
          await release.promise;
        }
        if (fail) {
          fail = false;
          throw new Error('unavailable');
        }
        if (JSON.stringify(writes.at(-1)) !== JSON.stringify(model)) writes.push(model);
        return true;
      },
      (error) => errors.push(error)
    );
    mirror.historyWriter.update(() => [assistant('a1', { modelId: 'one', name: '' })]);
    const first = handle.sync();
    await entered.promise;
    mirror.historyWriter.setField('a1', 'modelInfo', { modelId: 'two', name: '' });
    release.resolve();
    await first;
    await handle.flush();
    expect(writes).toEqual([{ modelId: 'one' }, { modelId: 'two' }]);
    fail = true;
    mirror.historyWriter.setField('a1', 'modelInfo', { modelId: 'three', name: '' });
    await handle.flush();
    expect(errors).toHaveLength(1);
    await handle.flush();
    expect(writes.at(-1)).toEqual({ modelId: 'three' });
    handle.dispose();
    mirror.dispose();
  });
});

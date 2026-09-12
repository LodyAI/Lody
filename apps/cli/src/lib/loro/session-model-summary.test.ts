import { describe, expect, it } from 'vitest';
import { LoroDoc } from 'loro-crdt';
import type { LoroRepo } from 'loro-repo';
import { SessionDocument } from './doc';
import type { Logger } from '@/utils/logger';
import {
  createSessionMirror,
  type SessionHistoryInput,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import { attachSessionModelSummary, latestSessionModel } from './session-model-summary';

const assistant = (
  id: string,
  modelInfo?: SessionHistoryInput['modelInfo']
): SessionHistoryInput => ({
  id,
  role: 'assistant',
  timestamp: '2026-09-12T00:00:00Z',
  items: [],
  modelInfo,
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
      await doc.updateHistory(() => [assistant('a1', { modelId: 'actual', name: 'Actual' })]);
      await doc.destroy({ preserveStatus: true });
      if (!initial || initial.deleted) expect(stored).toEqual(initial);
      else
        expect(stored?.meta).toEqual({
          id: 'model-test',
          lastModel: { modelId: 'actual', name: 'Actual' },
        });
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

  it('projects real history writes, coalesces streaming, handles rewind and stops on disposal', async () => {
    const mirror = createSessionMirror({
      doc: new LoroDoc(),
      initialState: { session: { id: 'model-test' as SessionId }, history: [] },
    });
    const writes: SessionMeta['lastModel'][] = [];
    const errors: unknown[] = [];
    const handle = attachSessionModelSummary(
      mirror,
      async (model) => {
        writes.push(model);
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
      mirror,
      async (model) => {
        if (!writes.length) {
          entered.resolve();
          await release.promise;
        }
        if (fail) {
          fail = false;
          throw new Error('unavailable');
        }
        writes.push(model);
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

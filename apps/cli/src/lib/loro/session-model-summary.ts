import type { SessionMeta, SessionMirror } from '@lody/shared';

export function latestSessionModel(
  history: readonly { role: string; modelInfo?: unknown }[]
): SessionMeta['lastModel'] {
  for (let index = history.length - 1; index >= 0; index--) {
    const entry = history[index];
    if (entry?.role !== 'assistant') continue;
    const value = entry.modelInfo;
    const model = (
      value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    ) as Record<string, unknown>;
    const modelId = typeof model?.modelId === 'string' ? model.modelId.trim() : '';
    const name = typeof model?.name === 'string' ? model.name.trim() : '';
    return { ...(modelId ? { modelId } : {}), ...(name ? { name } : {}) };
  }
  return null;
}

/** One coalesced writer; streaming text cannot enqueue a metadata write per token. */
export function attachSessionModelSummary(
  mirror: Pick<SessionMirror, 'subscribe' | 'getState'>,
  publish: (model: SessionMeta['lastModel'], active: () => boolean) => Promise<boolean>,
  onError: (error: unknown) => void
) {
  let disposed = false;
  let running: Promise<void> | undefined;
  let dirty = false;
  let published: string | undefined;
  const sync = (): Promise<void> => {
    dirty = true;
    if (running || disposed) return running ?? Promise.resolve();
    running = Promise.resolve()
      .then(async () => {
        while (dirty) {
          if (disposed) break;
          dirty = false;
          const model = latestSessionModel(mirror.getState().history ?? []);
          const key = JSON.stringify(model);
          if (key === published) continue;
          if (await publish(model, () => !disposed)) published = key;
        }
      })
      .catch(onError)
      .finally(() => {
        running = undefined;
        if (dirty && !disposed) void sync();
      });
    return running;
  };
  const unsubscribe = mirror.subscribe(() => {
    void sync();
  });
  return {
    sync,
    flush: async () => {
      await sync();
      for (let pending = running; pending; pending = running) await pending;
    },
    dispose: () => {
      disposed = true;
      unsubscribe();
    },
  };
}

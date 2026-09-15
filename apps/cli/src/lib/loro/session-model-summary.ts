import type { SessionMeta } from '@lody/shared';

export type SessionModelHistorySource = {
  subscribe: (listener: () => void) => () => void;
  latestModel: () => SessionMeta['lastModel'];
};

type AssistantLike = {
  role?: string;
  modelInfo?: unknown;
  items?: readonly unknown[];
  plan?: readonly unknown[];
};

// The renderer hides assistant entries with no items and no plan (interrupted or
// failed turns leave them behind); the summary must not advance on them either.
function projectAssistantModel(
  entry: AssistantLike | undefined
): SessionMeta['lastModel'] | undefined {
  if (entry?.role !== 'assistant') return;
  if (!entry.items?.length && !entry.plan?.length) return;
  const value = entry.modelInfo;
  const model = (
    value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  ) as Record<string, unknown>;
  const modelId = typeof model.modelId === 'string' ? model.modelId.trim() : '';
  const name = typeof model.name === 'string' ? model.name.trim() : '';
  return { ...(modelId ? { modelId } : {}), ...(name ? { name } : {}) };
}

export function latestSessionModel(history: readonly AssistantLike[]): SessionMeta['lastModel'] {
  for (let index = history.length - 1; index >= 0; index--) {
    const model = projectAssistantModel(history[index]);
    if (model !== undefined) return model;
  }
  return null;
}

export function latestSessionModelFromReader(history: {
  count(): number;
  readAt(position: number): { state: string; turn?: AssistantLike };
}): SessionMeta['lastModel'] {
  for (let index = history.count() - 1; index >= 0; index--) {
    const read = history.readAt(index);
    if (read.state !== 'ready') continue;
    const model = projectAssistantModel(read.turn);
    if (model !== undefined) return model;
  }
  return null;
}

/** One coalesced writer; streaming text cannot enqueue a metadata write per token. */
export function attachSessionModelSummary(
  source: SessionModelHistorySource,
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
          const model = source.latestModel();
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
  const unsubscribe = source.subscribe(() => {
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

import type { SessionMeta } from '@lody/shared';
import type { SessionModelSummaryReader } from '@lody/shared/session-data';

export type SessionModelHistorySource = {
  subscribe: (listener: () => void) => () => void;
  latestModel: () => SessionMeta['lastModel'];
};

type AssistantLike = {
  role?: string;
  modelInfo?: unknown;
  items?: { readonly length: number };
  plan?: { readonly length: number };
};

// The renderer hides assistant entries with no items and no plan (interrupted or
// failed turns leave them behind); the summary must not advance on them either.
function projectAssistantModel(
  entry: AssistantLike | undefined
): SessionMeta['lastModel'] | undefined {
  if (entry?.role !== 'assistant') return undefined;
  if (!entry.items?.length && !entry.plan?.length) return undefined;
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

export function latestSessionModelFromReader(
  history: SessionModelSummaryReader
): SessionMeta['lastModel'] {
  for (let index = history.count() - 1; index >= 0; index--) {
    const summary = history.readModelSummaryAt(index);
    if (summary?.role !== 'assistant') continue;
    const model = projectAssistantModel({
      role: 'assistant',
      modelInfo: summary.modelInfo,
      items: { length: summary.itemCount },
      plan: { length: summary.planCount },
    });
    if (model !== undefined) return model;
  }
  return null;
}

/** Serialize reconciliation; the publisher deduplicates against current metadata. */
export function attachSessionModelSummary(
  source: SessionModelHistorySource,
  publish: (model: SessionMeta['lastModel'], active: () => boolean) => Promise<boolean>,
  onError: (error: unknown) => void
) {
  let disposed = false;
  let running: Promise<void> | undefined;
  let dirty = false;
  const sync = (): Promise<void> => {
    dirty = true;
    if (running || disposed) return running ?? Promise.resolve();
    running = Promise.resolve()
      .then(async () => {
        while (dirty) {
          if (disposed) break;
          dirty = false;
          const model = source.latestModel();
          await publish(model, () => !disposed);
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

import type { QueryResult, ReadonlyJsonValue } from '@lody/plugin-sdk/client';

function canonical(value: ReadonlyJsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return (
    '{' +
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
      .join(',') +
    '}'
  );
}
interface ActiveQuery {
  id: string;
  target: string;
  refresh: () => void;
  close: () => void;
}
export class PluginQueryRegistry {
  private readonly entries = new Map<string, ActiveQuery>();
  constructor(private readonly signal: AbortSignal) {
    signal.addEventListener(
      'abort',
      () => {
        for (const q of this.entries.values()) q.close();
        this.entries.clear();
      },
      { once: true }
    );
  }
  query<T>(
    id: string,
    scope: string,
    target: string,
    input: ReadonlyJsonValue,
    fetch: (signal: AbortSignal) => Promise<T>
  ) {
    const key = JSON.stringify([id, scope, target, canonical(input)]);
    type Handle = {
      getSnapshot: () => QueryResult<T>;
      subscribe: (listener: () => void) => () => void;
    };
    const prior = this.entries.get(key) as (ActiveQuery & Handle) | undefined;
    if (prior) return prior;
    let snapshot: QueryResult<T> = { status: 'loading' };
    let current: AbortController | undefined;
    const listeners = new Set<() => void>();
    function update(next: QueryResult<T>) {
      snapshot = next;
      for (const listener of listeners) listener();
    }
    const refresh = () => {
      if (!listeners.size || this.signal.aborted) return;
      current?.abort();
      const controller = new AbortController();
      current = controller;
      update({ status: 'loading' });
      void Promise.resolve()
        .then(() => {
          controller.signal.throwIfAborted();
          return fetch(controller.signal);
        })
        .then(
          (data) => {
            if (!controller.signal.aborted) update({ status: 'ready', data, refresh });
          },
          (error) => {
            if (controller.signal.aborted) return;
            const code = error?.code;
            if (code === 'forbidden' || code === 'machine_offline')
              update({ status: 'unavailable', reason: code, refresh });
            else update({ status: 'error', message: String(error), refresh });
          }
        );
    };
    const entry = {
      id,
      target,
      refresh,
      close: () => {
        current?.abort();
        listeners.clear();
      },
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        if (this.signal.aborted) return () => {};
        listeners.add(listener);
        if (listeners.size === 1) refresh();
        return () => {
          listeners.delete(listener);
          if (!listeners.size) current?.abort();
        };
      },
    };
    if (!this.signal.aborted) this.entries.set(key, entry);
    return entry;
  }
  invalidate(id: string, target?: string) {
    for (const q of this.entries.values())
      if (q.id === id && (target === undefined || target === q.target)) q.refresh();
  }
  /** Machine invalidations carry no client-side target key; refresh every cached query. */
  invalidateAll() {
    for (const q of this.entries.values()) q.refresh();
  }
}

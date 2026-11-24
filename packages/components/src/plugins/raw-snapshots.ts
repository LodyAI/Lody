import { copyPluginSnapshot } from '@lody/shared/plugins/snapshot';
import { useMemo, useRef, useSyncExternalStore } from 'react';
import type { RawDocumentSnapshot, RawSnapshotTarget } from '@lody/plugin-sdk';
import type { ClientHostBindings, LodyClient, QueryResult } from '@lody/plugin-sdk/client';

type Target = RawSnapshotTarget;
export type SnapshotSlice = {
  identity: readonly unknown[];
  read: () => unknown | Promise<unknown>;
  release?: () => void;
};
export interface SnapshotSource {
  open(target: Target, notify: () => void, signal: AbortSignal): Promise<SnapshotSlice>;
  identity(target: Target): readonly unknown[];
}
const denied = () => Object.assign(Error('Snapshot target unavailable'), { code: 'forbidden' });
export function snapshotDocument(
  raw: unknown,
  path: readonly string[],
  pluginId: string,
  revision: string,
  kind: Target['kind']
): RawDocumentSnapshot {
  return Object.freeze({
    schemaVersion: 1,
    revision,
    doc: copyPluginSnapshot(raw, path, pluginId, kind),
  }) as RawDocumentSnapshot;
}
const same = (a: readonly unknown[], b: readonly unknown[]) =>
  a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
export function snapshotBindings(
  workspaceId: string,
  pluginId: string,
  signal: AbortSignal,
  source: () => SnapshotSource | undefined,
  subscribe: (fn: () => void) => () => void
) {
  function current(t: Target) {
    signal.throwIfAborted();
    const ref = 'workspace' in t ? t.workspace : 'project' in t ? t.project : t.session;
    const s = source();
    if (!s || ref.workspaceId !== workspaceId) throw denied();
    return s;
  }
  let revision = 0;
  const next = () => String(++revision);
  function guard(t: Target, id: readonly unknown[]) {
    if (!same(current(t).identity(t), id)) throw denied();
  }
  const readSnapshot: LodyClient['readSnapshot'] = async (target) => {
    const t = structuredClone(target);
    const s = await current(t).open(t, () => {}, signal);
    try {
      const raw = await s.read();
      guard(t, s.identity);
      return snapshotDocument(raw, 'path' in t ? (t.path ?? []) : [], pluginId, next(), t.kind);
    } finally {
      s.release?.();
    }
  };
  const slots = new Map<string, ReturnType<typeof createSlot>>();
  function createSlot(key: string, t: Target) {
    let result: QueryResult<RawDocumentSnapshot> = { status: 'loading' },
      slice: SnapshotSlice | undefined,
      controller: AbortController | undefined,
      stop: (() => void) | undefined,
      identity: readonly unknown[] | undefined;
    let dirty = true,
      inFlight = false,
      epoch = 0;
    const listeners = new Set<() => void>();
    const notify = () => {
      for (const fn of listeners) fn();
    };
    const invalidate = () => {
      dirty = true;
      ++epoch;
      notify();
    };
    const close = () => {
      controller?.abort();
      controller = undefined;
      slice?.release?.();
      slice = undefined;
      identity = undefined;
      epoch++;
      dirty = true;
      inFlight = false;
    };
    function failure(e: unknown): QueryResult<RawDocumentSnapshot> {
      return signal.aborted || (e as { code?: string })?.code === 'forbidden'
        ? { status: 'unavailable', reason: 'forbidden', refresh: invalidate }
        : { status: 'error', message: String(e), refresh: invalidate };
    }
    // Commits only mark the slice dirty. Reading the external store starts materialization.
    function get() {
      if (!listeners.size || !dirty || inFlight) return result;
      dirty = false;
      inFlight = true;
      const n = epoch;
      const active = (controller ??= new AbortController());
      const req = AbortSignal.any([signal, active.signal]);
      void (async () => {
        try {
          const src = current(t);
          identity = src.identity(t);
          if (!slice) {
            const lease = await src.open(t, invalidate, req);
            if (req.aborted) {
              lease.release?.();
              return;
            }
            slice = lease;
          }
          if (n !== epoch) return;
          const raw = await slice.read();
          if (req.aborted || n !== epoch) return;
          guard(t, slice.identity);
          result = {
            status: 'ready',
            data: snapshotDocument(
              raw,
              'path' in t ? (t.path ?? []) : [],
              pluginId,
              next(),
              t.kind
            ),
            refresh: invalidate,
          };
        } catch (e) {
          if (!req.aborted && n === epoch) result = failure(e);
        } finally {
          if (active === controller) {
            inFlight = false;
            notify();
          }
        }
      })();
      return result;
    }
    const changed = () => {
      try {
        const now = current(t).identity(t);
        if (identity && same(identity, now)) return;
        const changedOwner = !identity || identity[0] !== now[0] || identity[1] !== now[1];
        close();
        if (changedOwner) result = { status: 'loading' };
      } catch (e) {
        close();
        dirty = false;
        result = failure(e);
      }
      notify();
    };
    const abort = () => {
      close();
      dirty = false;
      result = failure(denied());
      notify();
    };
    function sub(fn: () => void) {
      listeners.add(fn);
      if (listeners.size === 1) {
        slots.set(key, api);
        let scheduled = false;
        stop = subscribe(() => {
          if (!scheduled) {
            scheduled = true;
            queueMicrotask(() => {
              scheduled = false;
              if (listeners.size) changed();
            });
          }
        });
        signal.addEventListener('abort', abort);
        if (signal.aborted) abort();
      }
      return () => {
        listeners.delete(fn);
        if (!listeners.size) {
          stop?.();
          signal.removeEventListener('abort', abort);
          close();
          if (slots.get(key) === api) slots.delete(key);
        }
      };
    }
    const api = { get, sub };
    return api;
  }
  const useLodySnapshot: ClientHostBindings['useLodySnapshot'] = <T = RawDocumentSnapshot>(
    target: Target,
    selector?: (s: RawDocumentSnapshot) => T,
    isEqual?: (a: T, b: T) => boolean
  ) => {
    const key = JSON.stringify(target);
    // Resolve the shared lease at subscription time: multiple consumers can render before either mounts.
    const slot = useMemo(() => {
      let live: ReturnType<typeof createSlot> | undefined;
      const loading: QueryResult<RawDocumentSnapshot> = { status: 'loading' };
      return {
        get: () => live?.get() ?? loading,
        sub: (fn: () => void) => {
          live = slots.get(key) ?? createSlot(key, JSON.parse(key));
          const stop = live.sub(fn);
          return () => {
            stop();
            live = undefined;
          };
        },
      };
    }, [key]);
    const memo = useRef<{
      slot: typeof slot;
      input: QueryResult<RawDocumentSnapshot>;
      selector: typeof selector;
      result: QueryResult<T>;
    } | null>(null);
    function selected(): QueryResult<T> {
      const input = slot.get(),
        prev = memo.current;
      if (prev?.slot === slot && prev.input === input && prev.selector === selector)
        return prev.result;
      let result: QueryResult<T>;
      if (input.status === 'ready') {
        const data = selector ? selector(input.data) : (input.data as T);
        result =
          prev?.slot === slot &&
          prev.result.status === 'ready' &&
          (isEqual ?? Object.is)(prev.result.data, data)
            ? prev.result
            : { ...input, data };
      } else result = input;
      memo.current = { slot, input, selector, result };
      return result;
    }
    return useSyncExternalStore(slot.sub, selected, selected);
  };
  return { readSnapshot, useLodySnapshot };
}

import { workspaceSupports } from '@lody/shared/workspace-streams-content';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import {
  getScheduleRegistryFlockDocId,
  ScheduleRegistryRowSchema,
  ScheduleRuntimeRowSchema,
  ScheduleTombstoneSchema,
  type ScheduleDocument,
  type ScheduleRegistryRow,
  type ScheduleRuntimeRow,
} from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { useResolvedWorkspaceScope } from './use-resolved-workspace-scope';
import { scheduleRegistryAtom, scheduleRegistryRetryAtom } from '@/atoms/schedules';
import { readinessBinding } from '@/lib/room-readiness';
import { recordClientError } from '@/lib/client-log';

/** Mounted once by the workspace shell, never once per list/detail consumer. */
export function useScheduleRegistrySync(): void {
  const activeRuntime = useAtomValue(activeWorkspaceRuntimeAtom);
  const scope = useResolvedWorkspaceScope();
  const runtime =
    scope.enabled && scope.workspaceId === activeRuntime?.workspaceId ? activeRuntime : null;
  const setSnapshot = useSetAtom(scheduleRegistryAtom);
  const retryGeneration = useAtomValue(scheduleRegistryRetryAtom);
  useEffect(() => {
    setSnapshot({
      workspaceId: runtime?.workspaceId ?? null,
      rows: [],
      runtimes: [],
      ready: false,
    });
    return () => setSnapshot({ workspaceId: null, rows: [], runtimes: [], ready: false });
  }, [runtime, setSnapshot]);
  useEffect(() => {
    let disposed = false;
    let off: (() => void) | undefined;
    let leave: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    let failed = false;
    let retries = 0;
    const retryDelays = [1000, 3000, 10000];
    if (
      !runtime ||
      !workspaceSupports(
        { mode: runtime.contentMode === 'e2ee' ? 'protected' : 'plaintext' },
        'schedules'
      )
    )
      return undefined;
    const roomId = getScheduleRegistryFlockDocId(runtime.workspaceId);
    let local:
      | {
          handle: Awaited<ReturnType<typeof runtime.repo.openFlockDoc>>;
          update: () => void;
        }
      | undefined;
    let synced = false;
    const releaseRoom = () => {
      leave?.();
      leave = undefined;
    };
    const releaseLocal = () => {
      off?.();
      off = undefined;
      local = undefined;
    };
    const run = async () => {
      if (disposed || running) return;
      running = true;
      failed = false;
      if (timer !== undefined) clearTimeout(timer);
      releaseRoom();
      setSnapshot((current) => ({ ...current, retrying: true }));
      let stage = 'open';
      try {
        if (!local) {
          const handle = await runtime.repo.openFlockDoc(roomId);
          if (disposed) return;
          // Catch-up delivers dozens of batches in one microtask drain; none may re-scan.
          const registry = {
            schedules: new Map<string, ScheduleRegistryRow>(),
            tombstones: new Set<string>(),
            runtimes: new Map<string, ScheduleRuntimeRow>(),
          };
          const publish = () => {
            if (disposed) return;
            const rows = [...registry.schedules.values()].filter(
              (entry) => !registry.tombstones.has(entry.scheduleId)
            );
            setSnapshot((current) => ({
              workspaceId: runtime.workspaceId,
              rows,
              runtimes: [...registry.runtimes.values()],
              // An empty local scan is not authoritative until first sync.
              ready: rows.length > 0 || synced || !!current.error,
              retrying: synced ? false : current.retrying,
              error: synced ? undefined : current.error,
            }));
          };
          const runtimeKey = (scheduleId: string, machineId: string) =>
            `${scheduleId}\u0000${machineId}`;
          const applyEvent = (event: { key: readonly unknown[]; value?: unknown }) => {
            const [family, id, machineId] = event.key;
            if (family === 'schedule' && typeof id === 'string' && event.key.length === 2) {
              if (event.value === undefined) {
                registry.schedules.delete(id);
                return;
              }
              const parsed = ScheduleRegistryRowSchema.safeParse(event.value);
              if (parsed.success && parsed.data.scheduleId === id)
                registry.schedules.set(id, parsed.data);
              else registry.schedules.delete(id);
              return;
            }
            if (family === 'tombstone' && typeof id === 'string' && event.key.length === 2) {
              if (event.value === undefined) {
                registry.tombstones.delete(id);
                return;
              }
              if (ScheduleTombstoneSchema.safeParse(event.value).success)
                registry.tombstones.add(id);
              return;
            }
            if (
              family === 'runtime' &&
              typeof id === 'string' &&
              typeof machineId === 'string' &&
              event.key.length === 3
            ) {
              const key = runtimeKey(id, machineId);
              if (event.value === undefined) {
                registry.runtimes.delete(key);
                return;
              }
              const parsed = ScheduleRuntimeRowSchema.safeParse(event.value);
              if (
                parsed.success &&
                parsed.data.scheduleId === id &&
                parsed.data.machineId === machineId
              )
                registry.runtimes.set(key, parsed.data);
              else registry.runtimes.delete(key);
            }
          };
          const rescan = () => {
            registry.schedules.clear();
            registry.tombstones.clear();
            registry.runtimes.clear();
            const scan = [...handle.flock.scan()];
            for (const entry of scan) applyEvent(entry);
          };
          stage = 'scan';
          const update = () => {
            if (disposed) return;
            rescan();
            publish();
          };
          off = handle.flock.subscribe((batch) => {
            if (disposed) return;
            const events = (
              batch as { events?: { key: readonly unknown[]; value?: unknown }[] } | undefined
            )?.events;
            if (!events) {
              update();
              return;
            }
            if (events.length === 0) return;
            for (const event of events) applyEvent(event);
            publish();
          });
          update();
          local = { handle, update };
        }
        stage = 'join';
        const room = await local.handle.joinRoom();
        if (disposed) {
          room.unsubscribe();
          return;
        }
        leave = () => room.unsubscribe();
        stage = 'first-sync';
        await readinessBinding(room).firstSyncedWithRemote;
        if (disposed) return;
        synced = true;
        stage = 'scan';
        local.update();
      } catch (error) {
        if (disposed) return;
        // Remote failure does not invalidate the readable local document.
        releaseRoom();
        if (stage === 'open' || stage === 'scan') releaseLocal();
        failed = true;
        recordClientError('schedules.registry_load_failed', error, { roomId, stage });
        setSnapshot((current) => ({
          ...current,
          ready: true,
          retrying: false,
          error: 'REGISTRY_UNAVAILABLE',
        }));
        const delay = retryDelays[retries++];
        if (delay !== undefined) timer = setTimeout(() => void run(), delay);
      } finally {
        running = false;
      }
    };
    const onOnline = () => {
      if (failed) void run();
    };
    window.addEventListener('online', onOnline);
    void run();
    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      window.removeEventListener('online', onOnline);
      releaseRoom();
      releaseLocal();
    };
  }, [runtime, setSnapshot, retryGeneration]);
}

export function useSchedules() {
  const activeRuntime = useAtomValue(activeWorkspaceRuntimeAtom);
  const scope = useResolvedWorkspaceScope();
  const runtime =
    scope.enabled && scope.workspaceId === activeRuntime?.workspaceId ? activeRuntime : null;
  const snapshot = useAtomValue(scheduleRegistryAtom);
  const requestRetry = useSetAtom(scheduleRegistryRetryAtom);
  const onRetry = useCallback(() => requestRetry((value) => value + 1), [requestRetry]);
  return useMemo(
    () =>
      snapshot.workspaceId === runtime?.workspaceId
        ? { ...snapshot, onRetry }
        : {
            workspaceId: runtime?.workspaceId ?? null,
            rows: [],
            runtimes: [],
            ready: false,
            onRetry,
          },
    [snapshot, runtime, onRetry]
  );
}

export function useScheduleDocument(id: string | undefined) {
  const activeRuntime = useAtomValue(activeWorkspaceRuntimeAtom);
  const scope = useResolvedWorkspaceScope();
  const runtime =
    scope.enabled && scope.workspaceId === activeRuntime?.workspaceId ? activeRuntime : null;
  const [value, setValue] = useState<{
    runtime: unknown;
    id: string;
    document: ScheduleDocument | null;
    ready: boolean;
  }>({ runtime: null, id: '', document: null, ready: false });
  useEffect(() => {
    if (!runtime || !id || id === 'new') return undefined;
    let disposed = false;
    let release: (() => void) | undefined;
    void runtime
      .acquireScheduleStore(id)
      .then(async (store) => {
        if (disposed) {
          runtime.releaseScheduleStoreRef(id);
          return;
        }
        let synced = false;
        const update = () => {
          const document = store.getState();
          if (!disposed) setValue({ runtime, id, document, ready: !!document || synced });
        };
        const off = store.subscribe(update);
        release = () => {
          off();
          runtime.releaseScheduleStoreRef(id);
        };
        update();
        await store.firstSynced;
        synced = true;
        update();
      })
      .catch(() => {
        if (!disposed) setValue({ runtime, id, document: null, ready: true });
      });
    return () => {
      disposed = true;
      release?.();
    };
  }, [runtime, id]);
  return value.runtime === runtime && value.id === id ? value : { document: null, ready: false };
}

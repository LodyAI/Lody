import { workspaceSupports } from '@lody/shared/workspace-streams-content';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import {
  getScheduleRegistryFlockDocId,
  createLegacyScheduleRegistry,
  type ScheduleDocument,
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
    const registry =
      runtime.scheduleRegistry ??
      createLegacyScheduleRegistry({
        workspaceId: runtime.workspaceId,
        repo: runtime.repo,
        releaseRoomOnSyncError: true,
        selectBinding: readinessBinding,
      });
    if (registry.workspaceId !== runtime.workspaceId) {
      setSnapshot((current) => ({
        ...current,
        ready: true,
        retrying: false,
        error: 'REGISTRY_UNAVAILABLE',
      }));
      return undefined;
    }
    let observation: Awaited<ReturnType<typeof registry.observe>> | undefined;
    const release = async () => {
      const owner = observation;
      if (!owner) return;
      await owner.close();
      if (observation === owner) observation = undefined;
    };
    const onFailure = (error: unknown) => {
      if (disposed) return;
      failed = true;
      recordClientError('schedules.registry_load_failed', error, { roomId, stage: 'observe' });
      setSnapshot((current) => ({
        ...current,
        ready: true,
        retrying: false,
        error: 'REGISTRY_UNAVAILABLE',
      }));
      const delay = retryDelays[retries++];
      if (delay !== undefined) timer = setTimeout(() => void run(), delay);
    };
    const run = async () => {
      if (disposed || running) return;
      running = true;
      failed = false;
      if (timer !== undefined) clearTimeout(timer);
      setSnapshot((current) => ({ ...current, retrying: true }));
      try {
        // A failed release retains its exact owner; do not acquire a duplicate.
        await release();
        const next = await registry.observe((snapshot) => {
          if (disposed) return;
          setSnapshot((current) => ({
            workspaceId: runtime.workspaceId,
            rows: snapshot.schedules,
            runtimes: snapshot.runtimes,
            ready: snapshot.schedules.length > 0 || snapshot.synced || !!current.error,
            retrying: snapshot.synced ? false : current.retrying,
            error: snapshot.synced ? undefined : current.error,
          }));
        }, onFailure);
        observation = next;
        if (disposed) await release();
      } catch (error) {
        onFailure(error);
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
      void release().catch((error) =>
        recordClientError('schedules.registry_release_failed', error, { roomId })
      );
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
  const ownerEpoch = useSyncExternalStore(
    useCallback((listener) => runtime && id && id !== 'new' ? runtime.subscribeDocumentDomainEpoch?.({ domain: 'schedule_definition', id }, listener) ?? (() => {}) : () => {}, [runtime, id]),
    useCallback(() => runtime && id && id !== 'new' ? runtime.getDocumentDomainEpoch?.({ domain: 'schedule_definition', id }) ?? 0 : 0, [runtime, id]),
    () => 0
  );
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
          runtime.releaseScheduleStoreRef(id, store);
          return;
        }
        let synced = false;
        const update = () => {
          const document = store.getState();
          if (!disposed) setValue({ runtime, id, document, ready: store.getSyncState ? store.getSyncState() === 'synced' : !!document || synced });
        };
        const off = store.subscribe(update);
        release = () => {
          off();
          runtime.releaseScheduleStoreRef(id, store);
        };
        update();
        await store.firstSynced;
        synced = true;
        update();
      })
      .catch(() => {
        if (!disposed) setValue({ runtime, id, document: null, ready: !runtime.scheduleDefinitions });
      });
    return () => {
      disposed = true;
      release?.();
    };
  }, [runtime, id, ownerEpoch]);
  return value.runtime === runtime && value.id === id ? value : { document: null, ready: false };
}

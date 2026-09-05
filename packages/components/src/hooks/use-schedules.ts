import { useEffect, useMemo, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import {
  getScheduleRegistryFlockDocId,
  readScheduleRegistryRows,
  ScheduleRuntimeRowSchema,
  type ScheduleDocument,
} from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { useResolvedWorkspaceScope } from './use-resolved-workspace-scope';
import { openScheduleTabsAtom, scheduleRegistryAtom } from '@/atoms/schedules';

/** Mounted once by the workspace shell, never once per list/detail consumer. */
export function useScheduleRegistrySync(): void {
  const activeRuntime = useAtomValue(activeWorkspaceRuntimeAtom);
  const scope = useResolvedWorkspaceScope();
  const runtime =
    scope.enabled && scope.workspaceId === activeRuntime?.workspaceId ? activeRuntime : null;
  const setSnapshot = useSetAtom(scheduleRegistryAtom);
  const setTabs = useSetAtom(openScheduleTabsAtom);
  useEffect(() => {
    let disposed = false;
    let off: (() => void) | undefined;
    let leave: (() => void) | undefined;
    setSnapshot({
      workspaceId: runtime?.workspaceId ?? null,
      rows: [],
      runtimes: [],
      ready: false,
    });
    void (async () => {
      if (!runtime) return;
      const handle = await runtime.repo.openFlockDoc(
        getScheduleRegistryFlockDocId(runtime.workspaceId)
      );
      if (disposed) return;
      const update = () => {
        if (disposed) return;
        const scan = [...handle.flock.scan()];
        setSnapshot({
          workspaceId: runtime.workspaceId,
          rows: readScheduleRegistryRows(scan),
          runtimes: scan.flatMap((entry) => {
            if (entry.key[0] !== 'runtime') return [];
            const parsed = ScheduleRuntimeRowSchema.safeParse(entry.value);
            return parsed.success &&
              entry.key[1] === parsed.data.scheduleId &&
              entry.key[2] === parsed.data.machineId
              ? [parsed.data]
              : [];
          }),
          ready: true,
        });
      };
      off = handle.flock.subscribe(update);
      update();
      const room = await handle.joinRoom();
      if (disposed) {
        room.unsubscribe();
        return;
      }
      leave = () => room.unsubscribe();
      await room.firstSyncedWithRemote;
      update();
    })().catch(() => {
      if (!disposed)
        setSnapshot({
          workspaceId: runtime?.workspaceId ?? null,
          rows: [],
          runtimes: [],
          ready: true,
          error: 'REGISTRY_UNAVAILABLE',
        });
    });
    return () => {
      disposed = true;
      off?.();
      leave?.();
      setTabs([]);
      setSnapshot({ workspaceId: null, rows: [], runtimes: [], ready: false });
    };
  }, [runtime, setSnapshot, setTabs]);
}

export function useSchedules() {
  const activeRuntime = useAtomValue(activeWorkspaceRuntimeAtom);
  const scope = useResolvedWorkspaceScope();
  const runtime =
    scope.enabled && scope.workspaceId === activeRuntime?.workspaceId ? activeRuntime : null;
  const snapshot = useAtomValue(scheduleRegistryAtom);
  return useMemo(
    () =>
      snapshot.workspaceId === runtime?.workspaceId
        ? snapshot
        : { workspaceId: runtime?.workspaceId ?? null, rows: [], runtimes: [], ready: false },
    [snapshot, runtime]
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

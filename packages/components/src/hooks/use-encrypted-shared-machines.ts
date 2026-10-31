import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useAtomValue } from 'jotai';
import type { MachineId, MachineViewMeta } from '@lody/shared';
import { usePlatform } from '@lody/platform/react';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { subscribeE2eeLedgerChanges } from '../providers/e2ee-runtime-notifications';
import {
  acquireEncryptedSharedMachineStore,
  createEncryptedSharedMachineStore,
  type EncryptedSharedMachines,
  type EncryptedSharedMachineStore,
} from '@/lib/encrypted-shared-machines';

const EMPTY: EncryptedSharedMachines = new Map();
const noop = () => () => {};

/**
 * Other members' machines this member may use in the active encrypted workspace,
 * from the host's verified policy view only. Ordinary workspaces, hosts without
 * the read port and pending runtimes return an empty map and start no reads.
 */
export function useEncryptedSharedMachines(input: {
  workspaceId: string | null;
  currentUserId: string | null;
  rawMachines: ReadonlyMap<MachineId, MachineViewMeta>;
  enabled: boolean;
}): EncryptedSharedMachines {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const port = usePlatform().e2eeWorkspaces?.runtime;
  const readMachineSharing = port?.readMachineSharing?.bind(port);
  const accountId =
    input.enabled &&
    runtime?.contentMode === 'e2ee' &&
    runtime.workspaceId === input.workspaceId &&
    runtime.accountId &&
    runtime.accountId === input.currentUserId
      ? runtime.accountId
      : null;
  const workspaceId = accountId ? input.workspaceId : null;
  const [store, setStore] = useState<EncryptedSharedMachineStore | null>(null);
  const hasPort = Boolean(readMachineSharing);
  useEffect(() => {
    if (!accountId || !workspaceId || !readMachineSharing) return undefined;
    const lease = acquireEncryptedSharedMachineStore({ accountId, workspaceId }, () =>
      createEncryptedSharedMachineStore({
        workspaceId,
        port: { readMachineSharing },
      })
    );
    setStore(lease.store);
    const refresh = () => lease.store.refresh();
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    const unsubscribeLedger = subscribeE2eeLedgerChanges(accountId, workspaceId, refresh);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      unsubscribeLedger();
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', onVisible);
      setStore(null);
      lease.release();
    };
    // The port is stable per platform; only account/workspace scope the store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, workspaceId, hasPort]);

  const candidateKey = useMemo(() => {
    if (!store || !accountId) return '';
    const ids: string[] = [];
    for (const [machineId, meta] of input.rawMachines)
      if (meta.ownerUserId && meta.ownerUserId !== accountId) ids.push(machineId);
    return ids.sort().join('\0');
  }, [accountId, input.rawMachines, store]);
  useEffect(() => {
    store?.setCandidates(candidateKey ? (candidateKey.split('\0') as MachineId[]) : []);
  }, [candidateKey, store]);

  const subscribe = useCallback(
    (listener: () => void) => store?.subscribe(listener) ?? noop(),
    [store]
  );
  const getSnapshot = useCallback(() => store?.getSnapshot() ?? EMPTY, [store]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

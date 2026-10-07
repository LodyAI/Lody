import { useCallback, useLayoutEffect, useMemo } from 'react';
import { atom, useAtomValue, useStore } from 'jotai';
import type { AcpConfigOptionValue } from '@lody/shared';
import {
  captureSessionRunConfigDraftAcceptance,
  editSessionRunConfigDraftAtom,
  getSessionRunConfigDraftKey,
  readSessionRunConfigDraftEdits,
  registerSessionRunConfigDraftLeaseAtom,
  releaseSessionRunConfigDraftLeaseAtom,
  sessionRunConfigDraftAccountAtom,
  sessionRunConfigDraftsAtom,
  type SessionRunConfigDraftLease,
  type SessionRunConfigDraftScope,
} from '@/atoms/session-run-config-drafts';
import type { AcpSessionConfigPreferences } from '@/lib/acp-session-config-selection';

export function useSessionRunConfigDraft(
  scope: SessionRunConfigDraftScope | undefined,
  enabled: boolean
) {
  const store = useStore();
  const owner = useAtomValue(sessionRunConfigDraftAccountAtom);
  const accountId = scope?.accountId;
  const workspaceId = scope?.workspaceId;
  const sessionId = scope?.sessionId;
  const targetKey = scope?.targetKey;
  const stableScope = useMemo(
    () =>
      accountId && workspaceId && sessionId && targetKey
        ? { accountId, workspaceId, sessionId, targetKey }
        : undefined,
    [accountId, workspaceId, sessionId, targetKey]
  );
  // No family or global selector cache: Jotai can release this atom on unmount.
  const selector = useMemo(
    () =>
      atom((get) =>
        stableScope
          ? get(sessionRunConfigDraftsAtom).get(getSessionRunConfigDraftKey(stableScope))
          : undefined
      ),
    [stableScope]
  );
  const draft = useAtomValue(selector);
  const leaseSlot = useMemo<{ current?: SessionRunConfigDraftLease }>(
    () => ({ current: undefined, scope: stableScope, lifetime: owner.lifetime, enabled }),
    [stableScope, owner.lifetime, enabled]
  );
  useLayoutEffect(() => {
    if (!enabled || !stableScope) return undefined;
    const lease = store.set(registerSessionRunConfigDraftLeaseAtom, stableScope);
    leaseSlot.current = lease;
    return () => {
      store.set(releaseSessionRunConfigDraftLeaseAtom, lease);
    };
  }, [enabled, stableScope, store, leaseSlot]);
  const update = useCallback(
    (edit: Parameters<typeof editSessionRunConfigDraftAtom.write>[2]['edit']) => {
      if (leaseSlot.current)
        store.set(editSessionRunConfigDraftAtom, { lease: leaseSlot.current, edit });
    },
    [store, leaseSlot]
  );
  const selectMode = useCallback(
    (value: string | null) => update({ type: 'mode', value }),
    [update]
  );
  const selectModel = useCallback(
    (value: string | null) => update({ type: 'model', value }),
    [update]
  );
  const selectConfigOption = useCallback(
    (configId: string, value: AcpConfigOptionValue) => update({ type: 'config', configId, value }),
    [update]
  );
  const replaceConfigOptions = useCallback(
    (values: Record<string, AcpConfigOptionValue>) => update({ type: 'replace-config', values }),
    [update]
  );
  const captureForSend = useCallback(
    (inputConfig: AcpSessionConfigPreferences) =>
      captureSessionRunConfigDraftAcceptance(store, leaseSlot.current, inputConfig, { draft }),
    [store, leaseSlot, draft]
  );
  const edits = useMemo(() => readSessionRunConfigDraftEdits(draft), [draft]);
  return {
    edits,
    selectMode,
    selectModel,
    selectConfigOption,
    replaceConfigOptions,
    captureForSend,
  };
}

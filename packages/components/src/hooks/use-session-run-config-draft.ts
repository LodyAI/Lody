import { useCallback, useLayoutEffect, useMemo, type RefObject } from 'react';
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
  type SessionRunConfigDraftEdit,
  type SessionRunConfigDraftLease,
  type SessionRunConfigDraftScope,
} from '@/atoms/session-run-config-drafts';
import type { AcpSessionConfigPreferences } from '@/lib/acp-session-config-selection';

export type SessionRunConfigModelContext = {
  fallbackModelId: string | null;
  resolvedModelId: string | null;
  modelConfigId: string | null;
  perModelConfigIds: ReadonlySet<string>;
};

export function useSessionRunConfigDraft(
  scope: SessionRunConfigDraftScope | undefined,
  enabled: boolean,
  modelContextRef?: RefObject<SessionRunConfigModelContext>
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
  // Old callbacks retain their own slot when scope, lifetime or readiness changes.
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
    (edit: SessionRunConfigDraftEdit) => {
      if (leaseSlot.current)
        store.set(editSessionRunConfigDraftAtom, { lease: leaseSlot.current, edit });
    },
    [store, leaseSlot]
  );
  const actions = useMemo(
    () => ({
      selectMode: (value: string | null) => update({ type: 'mode', value }),
      selectModel: (value: string | null) =>
        update({
          type: 'model',
          value,
          fallbackModelId: modelContextRef?.current?.fallbackModelId ?? null,
          resolvedModelId: modelContextRef?.current?.resolvedModelId ?? null,
          perModelConfigIds: modelContextRef?.current?.perModelConfigIds,
        }),
      selectConfigOption: (configId: string, value: AcpConfigOptionValue) =>
        update({
          type: 'config',
          configId,
          value,
          fallbackModelId: modelContextRef?.current?.fallbackModelId ?? null,
          resolvedModelId: modelContextRef?.current?.resolvedModelId ?? null,
          modelConfigId: modelContextRef?.current?.modelConfigId ?? null,
          perModelConfigIds: modelContextRef?.current?.perModelConfigIds,
        }),
      replaceConfigOptions: (values: Record<string, AcpConfigOptionValue>) =>
        update({ type: 'replace-config', values }),
    }),
    [modelContextRef, update]
  );
  const captureForSend = useCallback(
    (inputConfig: AcpSessionConfigPreferences) =>
      captureSessionRunConfigDraftAcceptance(store, leaseSlot.current, inputConfig, { draft }),
    [store, leaseSlot, draft]
  );
  const edits = useMemo(() => readSessionRunConfigDraftEdits(draft), [draft]);
  return {
    edits,
    ...actions,
    captureForSend,
  };
}

import { atom, type createStore } from 'jotai';
import type { AcpConfigOptionValue } from '@lody/shared';
import {
  EMPTY_ACP_SESSION_USER_CONFIG_EDITS,
  type AcpSessionConfigPreferences,
  type AcpSessionUserConfigEdits,
} from '@/lib/acp-session-config-selection';

type Store = ReturnType<typeof createStore>;
export type SessionRunConfigDraftScope = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  targetKey: string;
};
type Field<T> = { readonly value: T };
export type SessionRunConfigDraft = {
  readonly scope: SessionRunConfigDraftScope;
  readonly mode?: Field<string | null>;
  readonly model?: Field<string | null>;
  readonly configOptions: Readonly<Record<string, Field<AcpConfigOptionValue>>>;
};
export type SessionRunConfigDraftLease = {
  readonly scope: SessionRunConfigDraftScope;
  readonly lifetime: object;
  active: boolean;
};

export const getSessionRunConfigDraftTargetKey = (target: {
  cliType?: string | null;
  agentType?: string | null;
  agentConfigId?: string | null;
}): string =>
  JSON.stringify([target.cliType ?? null, target.agentType ?? null, target.agentConfigId ?? null]);

export const getSessionRunConfigDraftKey = (scope: SessionRunConfigDraftScope): string =>
  JSON.stringify([scope.accountId, scope.workspaceId, scope.sessionId, scope.targetKey]);

/** Only outstanding user intent lives here. Reading a session never inserts a row. */
export const sessionRunConfigDraftsAtom = atom<ReadonlyMap<string, SessionRunConfigDraft>>(
  new Map()
);
export const sessionRunConfigDraftAccountAtom = atom<{
  accountId: string | null;
  lifetime: object;
}>({
  accountId: null,
  lifetime: {},
});
// Mounted edit callbacks need cancellation, not persistent per-session tombstones.
// Unmount unregisters each lease; acceptance callbacks do not hold a lease open.
const mountedLeasesAtom = atom<ReadonlySet<SessionRunConfigDraftLease>>(
  new Set<SessionRunConfigDraftLease>()
);

export const setSessionRunConfigDraftAccountAtom = atom(
  null,
  (get, set, accountId: string | null) => {
    const owner = get(sessionRunConfigDraftAccountAtom);
    if (owner.accountId === accountId) return;
    for (const lease of get(mountedLeasesAtom)) lease.active = false;
    set(mountedLeasesAtom, new Set());
    set(sessionRunConfigDraftsAtom, new Map());
    set(sessionRunConfigDraftAccountAtom, { accountId, lifetime: {} });
  }
);

export const registerSessionRunConfigDraftLeaseAtom = atom(
  null,
  (get, set, scope: SessionRunConfigDraftScope): SessionRunConfigDraftLease => {
    const owner = get(sessionRunConfigDraftAccountAtom);
    const lease = { scope, lifetime: owner.lifetime, active: owner.accountId === scope.accountId };
    if (lease.active) set(mountedLeasesAtom, new Set([...get(mountedLeasesAtom), lease]));
    return lease;
  }
);
export const releaseSessionRunConfigDraftLeaseAtom = atom(
  null,
  (get, set, lease: SessionRunConfigDraftLease) => {
    lease.active = false;
    const leases = get(mountedLeasesAtom);
    if (!leases.has(lease)) return;
    const next = new Set(leases);
    next.delete(lease);
    set(mountedLeasesAtom, next);
  }
);

type Edit =
  | { type: 'mode'; value: string | null }
  | { type: 'model'; value: string | null }
  | { type: 'config'; configId: string; value: AcpConfigOptionValue }
  | { type: 'replace-config'; values: Record<string, AcpConfigOptionValue> };

export const editSessionRunConfigDraftAtom = atom(
  null,
  (get, set, { lease, edit }: { lease: SessionRunConfigDraftLease; edit: Edit }) => {
    if (!lease.active || get(sessionRunConfigDraftAccountAtom).lifetime !== lease.lifetime) return;
    const key = getSessionRunConfigDraftKey(lease.scope);
    const drafts = get(sessionRunConfigDraftsAtom);
    const current = drafts.get(key) ?? { scope: lease.scope, configOptions: {} };
    // A fresh object is a generation, even when the user picks the same value.
    const next: SessionRunConfigDraft =
      edit.type === 'mode' || edit.type === 'model'
        ? { ...current, [edit.type]: { value: edit.value } }
        : edit.type === 'config'
          ? {
              ...current,
              configOptions: { ...current.configOptions, [edit.configId]: { value: edit.value } },
            }
          : {
              ...current,
              configOptions: Object.fromEntries(
                Object.entries(edit.values).map(([id, value]) => [id, { value }])
              ),
            };
    const updated = new Map(drafts);
    if (!next.mode && !next.model && Object.keys(next.configOptions).length === 0)
      updated.delete(key);
    else updated.set(key, next);
    set(sessionRunConfigDraftsAtom, updated);
  }
);

export const readSessionRunConfigDraftEdits = (
  draft: SessionRunConfigDraft | undefined
): AcpSessionUserConfigEdits =>
  draft
    ? {
        ...(draft.mode ? { mode: draft.mode } : {}),
        ...(draft.model ? { model: draft.model } : {}),
        configOptions: Object.fromEntries(
          Object.entries(draft.configOptions).map(([id, field]) => [id, field.value])
        ),
      }
    : EMPTY_ACP_SESSION_USER_CONFIG_EDITS;

/** Capture beside the actual frozen inputConfig, before any await. */
export function captureSessionRunConfigDraftAcceptance(
  store: Store,
  lease: SessionRunConfigDraftLease | undefined,
  inputConfig: AcpSessionConfigPreferences,
  rendered?: { draft: SessionRunConfigDraft | undefined }
): (() => void) | undefined {
  if (!lease?.active || store.get(sessionRunConfigDraftAccountAtom).lifetime !== lease.lifetime)
    return undefined;
  const key = getSessionRunConfigDraftKey(lease.scope);
  const draft = rendered ? rendered.draft : store.get(sessionRunConfigDraftsAtom).get(key);
  if (!draft) return undefined;
  const mode = draft.mode?.value === (inputConfig.modeId ?? null) ? draft.mode : undefined;
  const model = draft.model?.value === (inputConfig.modelId ?? null) ? draft.model : undefined;
  const configOptions = Object.fromEntries(
    Object.entries(draft.configOptions).filter(
      ([id, field]) => inputConfig.configOptionValues?.[id] === field.value
    )
  );
  if (!mode && !model && Object.keys(configOptions).length === 0) return undefined;
  return () => {
    if (store.get(sessionRunConfigDraftAccountAtom).lifetime !== lease.lifetime) return;
    store.set(sessionRunConfigDraftsAtom, (drafts) => {
      const current = drafts.get(key);
      if (!current) return drafts;
      const remainingMode = current.mode === mode ? undefined : current.mode;
      const remainingModel = current.model === model ? undefined : current.model;
      const remainingConfig = Object.fromEntries(
        Object.entries(current.configOptions).filter(([id, field]) => configOptions[id] !== field)
      );
      if (
        remainingMode === current.mode &&
        remainingModel === current.model &&
        Object.keys(remainingConfig).length === Object.keys(current.configOptions).length
      )
        return drafts;
      const next = new Map(drafts);
      if (!remainingMode && !remainingModel && Object.keys(remainingConfig).length === 0)
        next.delete(key);
      else
        next.set(key, {
          scope: current.scope,
          ...(remainingMode ? { mode: remainingMode } : {}),
          ...(remainingModel ? { model: remainingModel } : {}),
          configOptions: remainingConfig,
        });
      return next;
    });
  };
}

/** Omit sessionIds for workspace removal; an empty list clears nothing. */
export const clearSessionRunConfigDraftsAtom = atom(
  null,
  (
    get,
    set,
    args: {
      workspaceId: string;
      sessionIds?: readonly string[];
      accountId?: string;
      lifetime?: object;
    }
  ) => {
    if (args.lifetime && get(sessionRunConfigDraftAccountAtom).lifetime !== args.lifetime) return;
    const ids = args.sessionIds === undefined ? undefined : new Set(args.sessionIds);
    const matches = (scope: SessionRunConfigDraftScope) =>
      scope.workspaceId === args.workspaceId &&
      (args.accountId === undefined || scope.accountId === args.accountId) &&
      (ids === undefined || ids.has(scope.sessionId));
    const drafts = get(sessionRunConfigDraftsAtom);
    const next = new Map([...drafts].filter(([, draft]) => !matches(draft.scope)));
    if (next.size !== drafts.size) set(sessionRunConfigDraftsAtom, next);
    const leases = get(mountedLeasesAtom);
    const remaining = new Set<SessionRunConfigDraftLease>();
    for (const lease of leases) {
      if (matches(lease.scope)) lease.active = false;
      else remaining.add(lease);
    }
    if (remaining.size !== leases.size) set(mountedLeasesAtom, remaining);
  }
);

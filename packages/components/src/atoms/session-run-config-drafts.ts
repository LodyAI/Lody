import { atom, type createStore } from 'jotai';
import { isModelScopedSessionDefaultConfigId, type AcpConfigOptionValue } from '@lody/shared';
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
  readonly modelConfigOptions?: Readonly<
    Record<string, Readonly<Record<string, Field<AcpConfigOptionValue>>>>
  >;
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

export type SessionRunConfigDraftEdit =
  | { type: 'mode'; value: string | null }
  | {
      type: 'model';
      value: string | null;
      fallbackModelId?: string | null;
      resolvedModelId?: string | null;
      perModelConfigIds?: ReadonlySet<string>;
    }
  | {
      type: 'config';
      configId: string;
      value: AcpConfigOptionValue;
      fallbackModelId?: string | null;
      resolvedModelId?: string | null;
      modelConfigId?: string | null;
      perModelConfigIds?: ReadonlySet<string>;
    }
  | { type: 'replace-config'; values: Record<string, AcpConfigOptionValue> };

const isPerModelFieldId = (configId: string, extra?: ReadonlySet<string>): boolean =>
  isModelScopedSessionDefaultConfigId(configId) || Boolean(extra?.has(configId));

const resolveCurrentDraftModelId = (
  draft: SessionRunConfigDraft,
  fallbackModelId?: string | null,
  modelConfigId?: string | null
): string | null => {
  if (draft.model) return draft.model.value;
  const key = modelConfigId ?? 'model';
  const modelField = draft.configOptions[key] ?? draft.configOptions.model;
  if (typeof modelField?.value === 'string') return modelField.value;
  return fallbackModelId ?? null;
};

const migrateFlatPerModelDraftFields = (
  draft: SessionRunConfigDraft,
  outgoingModelId: string | null,
  nextModelId: string | null,
  perModelConfigIds?: ReadonlySet<string>
): Pick<SessionRunConfigDraft, 'configOptions' | 'modelConfigOptions'> => {
  if (!outgoingModelId || outgoingModelId === nextModelId) {
    return {
      configOptions: draft.configOptions,
      ...(draft.modelConfigOptions ? { modelConfigOptions: draft.modelConfigOptions } : {}),
    };
  }
  let moved = false;
  const remainingCommon: Record<string, Field<AcpConfigOptionValue>> = {};
  const outgoingEntries: Record<string, Field<AcpConfigOptionValue>> = {
    ...draft.modelConfigOptions?.[outgoingModelId],
  };
  for (const [configId, field] of Object.entries(draft.configOptions)) {
    if (isPerModelFieldId(configId, perModelConfigIds)) {
      if (!(configId in outgoingEntries)) {
        outgoingEntries[configId] = field;
      }
      moved = true;
    } else {
      remainingCommon[configId] = field;
    }
  }
  if (!moved) {
    return {
      configOptions: draft.configOptions,
      ...(draft.modelConfigOptions ? { modelConfigOptions: draft.modelConfigOptions } : {}),
    };
  }
  const nextModelMap = {
    ...draft.modelConfigOptions,
    ...(Object.keys(outgoingEntries).length > 0 ? { [outgoingModelId]: outgoingEntries } : {}),
  };
  return {
    configOptions: remainingCommon,
    ...(Object.keys(nextModelMap).length > 0 ? { modelConfigOptions: nextModelMap } : {}),
  };
};

const isDraftEmpty = (draft: SessionRunConfigDraft): boolean =>
  !draft.mode &&
  !draft.model &&
  Object.keys(draft.configOptions).length === 0 &&
  Object.keys(draft.modelConfigOptions ?? {}).length === 0;

export const editSessionRunConfigDraftAtom = atom(
  null,
  (
    get,
    set,
    { lease, edit }: { lease: SessionRunConfigDraftLease; edit: SessionRunConfigDraftEdit }
  ) => {
    if (!lease.active || get(sessionRunConfigDraftAccountAtom).lifetime !== lease.lifetime) return;
    const key = getSessionRunConfigDraftKey(lease.scope);
    const drafts = get(sessionRunConfigDraftsAtom);
    const current = drafts.get(key) ?? { scope: lease.scope, configOptions: {} };
    // A fresh object is a generation, even when the user picks the same value.
    let next: SessionRunConfigDraft;
    if (edit.type === 'mode') {
      next = { ...current, mode: { value: edit.value } };
    } else if (edit.type === 'model') {
      const outgoingModelId = resolveCurrentDraftModelId(
        current,
        edit.fallbackModelId ?? edit.resolvedModelId ?? null
      );
      const migrated = migrateFlatPerModelDraftFields(
        current,
        outgoingModelId,
        edit.value,
        edit.perModelConfigIds
      );
      next = {
        scope: current.scope,
        ...(current.mode ? { mode: current.mode } : {}),
        model: { value: edit.value },
        configOptions: migrated.configOptions,
        ...(migrated.modelConfigOptions ? { modelConfigOptions: migrated.modelConfigOptions } : {}),
      };
    } else if (edit.type === 'config') {
      const modelOptionId = edit.modelConfigId ?? 'model';
      if (edit.configId === modelOptionId && typeof edit.value === 'string') {
        const outgoingModelId = resolveCurrentDraftModelId(
          current,
          edit.fallbackModelId ?? edit.resolvedModelId ?? null,
          modelOptionId
        );
        const migrated = migrateFlatPerModelDraftFields(
          current,
          outgoingModelId,
          edit.value,
          edit.perModelConfigIds
        );
        next = {
          scope: current.scope,
          ...(current.mode ? { mode: current.mode } : {}),
          ...(current.model ? { model: current.model } : {}),
          configOptions: { ...migrated.configOptions, [edit.configId]: { value: edit.value } },
          ...(migrated.modelConfigOptions
            ? { modelConfigOptions: migrated.modelConfigOptions }
            : {}),
        };
      } else if (isPerModelFieldId(edit.configId, edit.perModelConfigIds)) {
        const activeModelId = resolveCurrentDraftModelId(
          current,
          edit.fallbackModelId ?? null,
          modelOptionId
        );
        if (activeModelId) {
          const nextCommon = { ...current.configOptions };
          delete nextCommon[edit.configId];
          const nextModelOptions = {
            ...current.modelConfigOptions,
            [activeModelId]: {
              ...current.modelConfigOptions?.[activeModelId],
              [edit.configId]: { value: edit.value },
            },
          };
          next = {
            ...current,
            configOptions: nextCommon,
            modelConfigOptions: nextModelOptions,
          };
        } else {
          next = {
            ...current,
            configOptions: { ...current.configOptions, [edit.configId]: { value: edit.value } },
          };
        }
      } else {
        next = {
          ...current,
          configOptions: { ...current.configOptions, [edit.configId]: { value: edit.value } },
        };
      }
    } else {
      next = {
        scope: current.scope,
        ...(current.mode ? { mode: current.mode } : {}),
        ...(current.model ? { model: current.model } : {}),
        configOptions: Object.fromEntries(
          Object.entries(edit.values).map(([id, value]) => [id, { value }])
        ),
      };
    }
    const updated = new Map(drafts);
    if (isDraftEmpty(next)) updated.delete(key);
    else updated.set(key, next);
    set(sessionRunConfigDraftsAtom, updated);
  }
);

export const readSessionRunConfigDraftEdits = (
  draft: SessionRunConfigDraft | undefined
): AcpSessionUserConfigEdits => {
  if (!draft) return EMPTY_ACP_SESSION_USER_CONFIG_EDITS;
  const modelConfigOptions = draft.modelConfigOptions
    ? Object.fromEntries(
        Object.entries(draft.modelConfigOptions)
          .map(([modelId, entries]) => [
            modelId,
            Object.fromEntries(Object.entries(entries).map(([id, field]) => [id, field.value])),
          ])
          .filter(([, entries]) => Object.keys(entries).length > 0)
      )
    : undefined;
  return {
    ...(draft.mode ? { mode: draft.mode } : {}),
    ...(draft.model ? { model: draft.model } : {}),
    configOptions: Object.fromEntries(
      Object.entries(draft.configOptions).map(([id, field]) => [id, field.value])
    ),
    ...(modelConfigOptions && Object.keys(modelConfigOptions).length > 0
      ? { modelConfigOptions }
      : {}),
  };
};

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
  const sentModelId =
    inputConfig.modelId ??
    (typeof inputConfig.configOptionValues?.model === 'string'
      ? inputConfig.configOptionValues.model
      : null);
  const capturedModelFields =
    sentModelId && draft.modelConfigOptions?.[sentModelId]
      ? Object.fromEntries(
          Object.entries(draft.modelConfigOptions[sentModelId]).filter(
            ([id, field]) => inputConfig.configOptionValues?.[id] === field.value
          )
        )
      : undefined;
  if (
    !mode &&
    !model &&
    Object.keys(configOptions).length === 0 &&
    Object.keys(capturedModelFields ?? {}).length === 0
  )
    return undefined;
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
      let remainingModelConfig = current.modelConfigOptions;
      let modelConfigChanged = false;
      if (sentModelId && capturedModelFields && current.modelConfigOptions?.[sentModelId]) {
        const currentForModel = current.modelConfigOptions[sentModelId];
        const filteredForModel = Object.fromEntries(
          Object.entries(currentForModel).filter(([id, field]) => capturedModelFields[id] !== field)
        );
        if (Object.keys(filteredForModel).length !== Object.keys(currentForModel).length) {
          modelConfigChanged = true;
          const copy = { ...current.modelConfigOptions };
          if (Object.keys(filteredForModel).length > 0) {
            copy[sentModelId] = filteredForModel;
          } else {
            delete copy[sentModelId];
          }
          remainingModelConfig = Object.keys(copy).length > 0 ? copy : undefined;
        }
      }
      if (
        remainingMode === current.mode &&
        remainingModel === current.model &&
        Object.keys(remainingConfig).length === Object.keys(current.configOptions).length &&
        !modelConfigChanged
      )
        return drafts;
      const next = new Map(drafts);
      const updatedDraft: SessionRunConfigDraft = {
        scope: current.scope,
        ...(remainingMode ? { mode: remainingMode } : {}),
        ...(remainingModel ? { model: remainingModel } : {}),
        configOptions: remainingConfig,
        ...(remainingModelConfig ? { modelConfigOptions: remainingModelConfig } : {}),
      };
      if (isDraftEmpty(updatedDraft)) next.delete(key);
      else next.set(key, updatedDraft);
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

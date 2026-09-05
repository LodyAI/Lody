import { useCallback, useEffect, useMemo } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import type { AgentConfigId, AgentRoleId, MachineId, SessionId } from '@lody/shared';

import { getAllAgentConfigAtom } from '@/atoms/agents';
import {
  sessionAgentRoleDurableSnapshotAtomFamily,
  sessionAgentRoleSelectionAtomFamily,
} from '@/atoms/session-agent-roles';
import type {
  AcpConfigOptionSelector,
  AcpConfigOptionValue,
} from '@/components/shared/acp-selector-options';
import type { AcpSessionSelectOption } from '@/components/shared/acp-session-select';
import { filterAcpSessionConfigOptionValues } from '@/lib/acp-session-config-selection';
import {
  isAgentRoleRunConfigApplied,
  selectSessionAgentRoles,
  type ComposerAgentRoleItem,
  type SessionTurnAgentRoleSelection,
} from '@/lib/composer-agent-roles';
import {
  useAgentRoleAvailability,
  useWorkspaceAgentRoles,
} from '@/hooks/use-workspace-agent-roles';

export type SessionAgentRoleControl = {
  items: ComposerAgentRoleItem[];
  /** The Role this session's run config still IS, not merely the last picked. */
  selectedRoleId: AgentRoleId | null;
  /** Three-state Turn metadata: undefined=legacy/unknown, null=explicit None. */
  turnSelection?: SessionTurnAgentRoleSelection;
  onSelect: (roleId: AgentRoleId | null) => void;
};

/**
 * The Role row for an EXISTING session's composer.
 *
 * A live session's agent is fixed, so this is deliberately not the landing's
 * feature. It offers only Roles bound to the Session's exact machine and Agent
 * Config (its model provider), and applies only their RUN CONFIG — model,
 * reasoning, permission, and whatever else that agent publishes — because
 * those are exactly the values a session can still change per turn. The Role's
 * machine, config, and instruction are not applied and are not claimed to be.
 *
 * Applied by calling the composer's own change callbacks rather than through a
 * preference channel: this surface has no reconcile pass to seed, and a value
 * the agent does not support is skipped rather than forced in. An unsent picked
 * Role lives in session-keyed app state because navigation unmounts this
 * composer; accepted choices live in synchronized Turn inputConfig.
 */
export function useSessionAgentRole({
  sessionId,
  provenanceRoleId,
  provenanceRoleRevision,
  durableRoleId,
  durableRoleRevision,
  durableSourceTurnKey,
  durableKnownSourceTurnKeys = [],
  durableRoleReady = true,
  machineId,
  agentConfigId,
  modelOptions,
  selectedModelId,
  onModelChange,
  modeOptions,
  selectedModeId,
  onModeChange,
  configOptionSelectors,
  configOptionValues,
  runConfigHasUserEdits = false,
  onConfigOptionChange,
}: {
  sessionId: SessionId;
  /** Role that created this session; seeds only the composer's display name. */
  provenanceRoleId?: AgentRoleId;
  provenanceRoleRevision?: number;
  /** Latest accepted/queued Turn selection. Null is explicit None. */
  durableRoleId?: AgentRoleId | null;
  durableRoleRevision?: number;
  /** Stable logical Turn identity used to fence local unsent choices. */
  durableSourceTurnKey?: string;
  /** Logical Turns visible when the latest durable snapshot was resolved. */
  durableKnownSourceTurnKeys?: readonly string[];
  /** False while the Session document is hydrating after a remount. */
  durableRoleReady?: boolean;
  machineId: MachineId | null | undefined;
  agentConfigId: AgentConfigId | null | undefined;
  modelOptions: ReadonlyArray<AcpSessionSelectOption>;
  selectedModelId: string | null;
  onModelChange?: (value: string) => void;
  modeOptions: ReadonlyArray<AcpSessionSelectOption>;
  selectedModeId: string | null;
  onModeChange?: (value: string) => void;
  configOptionSelectors: ReadonlyArray<AcpConfigOptionSelector>;
  configOptionValues: Record<string, AcpConfigOptionValue | undefined> | undefined;
  /** Tracks manual drift even while the selected Role row is unavailable. */
  runConfigHasUserEdits?: boolean;
  onConfigOptionChange?: (configId: string, value: AcpConfigOptionValue) => void;
}): SessionAgentRoleControl {
  const { roles, synced: agentRolesSynced } = useWorkspaceAgentRoles();
  const scopedRoles = useMemo(
    () =>
      machineId && agentConfigId
        ? roles.filter(
            (role) => role.machineId === machineId && role.agentConfigId === agentConfigId
          )
        : [],
    [agentConfigId, machineId, roles]
  );
  const { resolve: resolveAvailability } = useAgentRoleAvailability(scopedRoles);
  const agentConfigs = useAtomValue(getAllAgentConfigAtom);
  const resolvedItems = useMemo(
    () =>
      selectSessionAgentRoles({
        roles: scopedRoles,
        machineId,
        agentConfigId,
        agentConfigs,
        resolveAvailability,
      }),
    [agentConfigId, agentConfigs, machineId, resolveAvailability, scopedRoles]
  );
  const items = useMemo(
    () =>
      durableRoleReady
        ? resolvedItems
        : resolvedItems.map((item) => ({ ...item, availability: { kind: 'unknown' } as const })),
    [durableRoleReady, resolvedItems]
  );

  /* Which Role was picked, as a NAME. A newly created session starts with its
     provenance Role, while an explicit choice (including None) overrides that
     seed in session-keyed app state. Whether the Role still describes the run
     config is derived below, so a knob moved by hand takes the name away on its
     own. */
  const [selectionOverride, setSelectionOverride] = useAtom(
    sessionAgentRoleSelectionAtomFamily(sessionId)
  );
  const [durableSnapshot, setDurableSnapshot] = useAtom(
    sessionAgentRoleDurableSnapshotAtomFamily(sessionId)
  );
  const hydratedTurnKey = durableSourceTurnKey ?? null;
  const hydratedKnownTurnKeys = useMemo(
    () =>
      durableKnownSourceTurnKeys.length > 0
        ? durableKnownSourceTurnKeys
        : hydratedTurnKey
          ? [hydratedTurnKey]
          : [],
    [durableKnownSourceTurnKeys, hydratedTurnKey]
  );
  const effectiveKnownTurnKeys = durableRoleReady
    ? hydratedKnownTurnKeys
    : (durableSnapshot?.knownTurnKeys ??
      selectionOverride?.basedOnTurnKeys ??
      hydratedKnownTurnKeys);
  const effectiveDurableRoleId =
    !durableRoleReady && durableSnapshot ? durableSnapshot.roleId : durableRoleId;
  const effectiveDurableRoleRevision =
    !durableRoleReady && durableSnapshot ? durableSnapshot.roleRevision : durableRoleRevision;
  useEffect(() => {
    if (!durableRoleReady) return;
    setDurableSnapshot((current) => {
      if (
        current &&
        current.roleId === durableRoleId &&
        current.roleRevision === durableRoleRevision &&
        current.currentTurnKey === hydratedTurnKey &&
        current.knownTurnKeys.length === hydratedKnownTurnKeys.length &&
        current.knownTurnKeys.every((key, index) => key === hydratedKnownTurnKeys[index])
      ) {
        return current;
      }
      return {
        roleId: durableRoleId,
        roleRevision: durableRoleRevision,
        currentTurnKey: hydratedTurnKey,
        knownTurnKeys: hydratedKnownTurnKeys,
      };
    });
  }, [
    durableRoleId,
    durableRoleReady,
    durableRoleRevision,
    hydratedKnownTurnKeys,
    hydratedTurnKey,
    setDurableSnapshot,
  ]);
  const selectionOverrideIsCurrent =
    !selectionOverride ||
    !hydratedTurnKey ||
    selectionOverride.basedOnTurnKeys.includes(hydratedTurnKey);
  const pickedRoleId =
    selectionOverride && (!durableRoleReady || selectionOverrideIsCurrent)
      ? selectionOverride.roleId
      : effectiveDurableRoleId !== undefined
        ? effectiveDurableRoleId
        : (provenanceRoleId ?? null);
  useEffect(() => {
    if (!durableRoleReady || !selectionOverride || selectionOverrideIsCurrent) {
      return;
    }
    // A newer durable Turn permanently consumes this draft. Otherwise deleting
    // a queued Turn could return the resolver to an older source and resurrect
    // a choice that was already sent or superseded.
    setSelectionOverride(undefined);
  }, [durableRoleReady, selectionOverride, selectionOverrideIsCurrent, setSelectionOverride]);
  const selection = useMemo(
    () => ({
      modeId: selectedModeId,
      modelId: selectedModelId,
      configOptionValues: configOptionValues ?? {},
    }),
    [configOptionValues, selectedModeId, selectedModelId]
  );
  const selectedRoleId = useMemo(() => {
    if (!pickedRoleId) return null;
    const role = items.find((item) => item.role.id === pickedRoleId)?.role;
    if (!role) return null;
    return !durableRoleReady || isAgentRoleRunConfigApplied(role, selection) ? role.id : null;
  }, [durableRoleReady, items, pickedRoleId, selection]);
  const pickedItem = pickedRoleId ? items.find((item) => item.role.id === pickedRoleId) : undefined;
  const storedPickedRevision =
    effectiveDurableRoleId === pickedRoleId
      ? effectiveDurableRoleRevision
      : provenanceRoleId === pickedRoleId
        ? provenanceRoleRevision
        : undefined;
  const turnSelection: SessionTurnAgentRoleSelection =
    selectedRoleId && pickedItem
      ? {
          agentRoleId: selectedRoleId,
          agentRoleRevision: pickedItem.role.revision,
        }
      : pickedRoleId === null
        ? null
        : pickedItem
          ? // A manual run-config change means this is no longer that Role.
            null
          : !agentRolesSynced
            ? runConfigHasUserEdits
              ? undefined
              : typeof storedPickedRevision === 'number'
                ? { agentRoleId: pickedRoleId, agentRoleRevision: storedPickedRevision }
                : undefined
            : scopedRoles.some((role) => role.id === pickedRoleId)
              ? typeof storedPickedRevision === 'number'
                ? { agentRoleId: pickedRoleId, agentRoleRevision: storedPickedRevision }
                : undefined
              : // The synchronized catalog authoritatively no longer contains it.
                null;

  const onSelect = useCallback(
    (roleId: AgentRoleId | null) => {
      if (roleId === null) {
        // Clears the NAME, not the configuration: the values are the user's own
        // now, and rolling them back would undo choices they never asked to undo.
        if (!durableRoleReady) return;
        setSelectionOverride({ roleId: null, basedOnTurnKeys: effectiveKnownTurnKeys });
        return;
      }
      const item = items.find((candidate) => candidate.role.id === roleId);
      if (!item || item.availability.kind !== 'available') return;
      const { role } = item;
      setSelectionOverride({ roleId, basedOnTurnKeys: effectiveKnownTurnKeys });

      const { modelId, modeId, configOptionValues: pinned } = role.runConfig;
      const appliedModelId =
        modelId && modelOptions.some((option) => option.value === modelId) ? modelId : undefined;
      if (appliedModelId) {
        onModelChange?.(appliedModelId);
      }
      if (modeId && modeOptions.some((option) => option.value === modeId)) {
        onModeChange?.(modeId);
      }
      // An option this agent dropped, or whose value it no longer offers, is
      // skipped rather than forced back in — through the same filter every
      // other surface applies to remembered values. A Role that also pins a
      // different model is the exception: the selectors describe the outgoing
      // model, whose ladder must not decide the pinned effort.
      for (const [configId, value] of Object.entries(
        filterAcpSessionConfigOptionValues(pinned, configOptionSelectors, {
          switchesModel: appliedModelId !== undefined && appliedModelId !== selectedModelId,
        })
      )) {
        onConfigOptionChange?.(configId, value);
      }
    },
    [
      configOptionSelectors,
      durableRoleReady,
      effectiveKnownTurnKeys,
      items,
      modeOptions,
      modelOptions,
      onConfigOptionChange,
      onModeChange,
      onModelChange,
      selectedModelId,
      setSelectionOverride,
    ]
  );

  return { items, selectedRoleId, turnSelection, onSelect };
}

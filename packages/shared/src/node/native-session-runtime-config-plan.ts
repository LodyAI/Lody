import { isSensitiveAcpConfigOptionId } from '../acp-config-option-sensitivity';
import type { SessionAcpRuntimeConfigPatch, SessionAcpRuntimeConfigSnapshot } from '../index';
const valuesEqual = (
  left: SessionAcpRuntimeConfigSnapshot['configOptionValues'],
  right: SessionAcpRuntimeConfigSnapshot['configOptionValues']
) =>
  left === right ||
  Boolean(
    left &&
    right &&
    Object.keys(left).length === Object.keys(right).length &&
    Object.keys(left).every((key) => left[key] === right[key])
  );
/** Shared with the legacy SessionDocument. The caller binds this plan and its
 * history-directory guard to the owning backend's current transaction. */
export function prepareSessionAcpRuntimeConfig(input: {
  readonly basedOnUserTurnId: string;
  readonly patch: SessionAcpRuntimeConfigPatch;
  readonly userTurnIndices: ReadonlyMap<string, number>;
  readonly latestUserTurnIndex: number;
  readonly current?: SessionAcpRuntimeConfigSnapshot;
}): SessionAcpRuntimeConfigSnapshot | undefined {
  const { basedOnUserTurnId, userTurnIndices, latestUserTurnIndex, current } = input;
  const patch =
    input.patch.configOptionValues === undefined
      ? input.patch
      : {
          ...input.patch,
          configOptionValues: Object.fromEntries(
            Object.entries(input.patch.configOptionValues).filter(
              ([id]) => !isSensitiveAcpConfigOptionId(id)
            )
          ),
        };
  const incoming = userTurnIndices.get(basedOnUserTurnId) ?? -1;
  if (
    incoming < 0 ||
    incoming !== latestUserTurnIndex ||
    (current && (userTurnIndices.get(current.basedOnUserTurnId) ?? -1) > incoming)
  )
    return;
  const continues =
    current?.acpSessionId === patch.acpSessionId && current.basedOnUserTurnId === basedOnUserTurnId;
  const next: Omit<SessionAcpRuntimeConfigSnapshot, 'revision'> = {
    ...(current?.acpSessionId === patch.acpSessionId && current.availableCommands !== undefined
      ? { availableCommands: current.availableCommands }
      : {}),
    ...(continues
      ? {
          ...(current.modeId !== undefined ? { modeId: current.modeId } : {}),
          ...(current.modelId !== undefined ? { modelId: current.modelId } : {}),
          ...(current.configOptionValues !== undefined
            ? { configOptionValues: current.configOptionValues }
            : {}),
        }
      : {}),
    ...patch,
    basedOnUserTurnId,
  };
  if (
    current &&
    current.acpSessionId === next.acpSessionId &&
    current.basedOnUserTurnId === next.basedOnUserTurnId &&
    current.modeId === next.modeId &&
    current.modelId === next.modelId &&
    JSON.stringify(
      current.availableCommands?.map(({ name, description }) => ({ name, description }))
    ) ===
      JSON.stringify(
        next.availableCommands?.map(({ name, description }) => ({ name, description }))
      ) &&
    valuesEqual(current.configOptionValues, next.configOptionValues)
  )
    return;
  return { ...next, revision: (current?.revision ?? 0) + 1 };
}

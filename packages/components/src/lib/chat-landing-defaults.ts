import type { AgentConfigId, AgentConfigMeta, MachineId, MachineViewMeta } from '@lody/shared';
import { z } from 'zod';
import type { AgentSelection } from '@/components/shared';

const lastUsedProjectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('github'), repoFullName: z.string().min(1) }),
  z.object({
    kind: z.literal('local'),
    machineId: z.string().min(1),
    localProjectId: z.string().min(1),
  }),
  z.object({ kind: z.literal('group'), projectId: z.string().min(1) }),
]);

export const chatLandingDefaultsSchema = z.object({
  /** Accepted send target; browsing and draft selection must not overwrite it. */
  lastUsedProject: lastUsedProjectSchema.optional().catch(undefined),
  agentId: z.string().nullable().optional(),
  machineId: z.string().nullable().optional(),
  repoFullName: z.string().nullable().optional(),
  branch: z.string().nullable().optional(),
  localMachineId: z.string().nullable().optional(),
  localProjectId: z.string().nullable().optional(),
  localBranch: z.string().nullable().optional(),
  contextType: z.enum(['local', 'github', 'chat']).nullable().optional(),
  /** Last Agent Role the composer was configured as, by stable Role id. */
  agentRoleId: z.string().nullable().optional(),
});

export type ChatLandingDefaults = z.infer<typeof chatLandingDefaultsSchema>;
export const CHAT_LANDING_DEFAULTS_KEY = 'lody:chatLandingDefaults';

export const getChatLandingDefaultsStorageKey = (workspaceId: string): string =>
  `${CHAT_LANDING_DEFAULTS_KEY}:${workspaceId}`;

export function readChatLandingDefaults(
  workspaceId: string | null | undefined
): ChatLandingDefaults | null {
  if (!workspaceId) return null;
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(getChatLandingDefaultsStorageKey(workspaceId));
    if (!raw) return null;
    const parsed = chatLandingDefaultsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeChatLandingDefaults(
  workspaceId: string | null | undefined,
  defaults: ChatLandingDefaults
): void {
  if (!workspaceId) return;
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(getChatLandingDefaultsStorageKey(workspaceId), JSON.stringify(defaults));
  } catch {
    // ignore
  }
}

export function recordChatLandingProjectUse(
  workspaceId: string,
  project: NonNullable<ChatLandingDefaults['lastUsedProject']>
) {
  writeChatLandingDefaults(workspaceId, {
    ...readChatLandingDefaults(workspaceId),
    lastUsedProject: project,
  });
}

export function getChatLandingAgentSelectionsForMachine(
  executorConfigs: AgentConfigMeta[],
  machineId: MachineId | null | undefined
): AgentSelection[] {
  if (!machineId) return [];
  return executorConfigs.flatMap((config) =>
    config.machineId === machineId
      ? [{ agentId: config.id, machineId: config.machineId } satisfies AgentSelection]
      : []
  );
}

type ResolvePreferredChatLandingAgentSelectionArgs = {
  preferredAgentId?: AgentConfigId | string | null;
  preferredMachineId?: MachineId | string | null;
  requiredMachineId?: MachineId | string | null;
  executorConfigs: AgentConfigMeta[];
  machines: Map<string, MachineViewMeta>;
};

export function resolvePreferredChatLandingAgentSelection({
  preferredAgentId,
  preferredMachineId,
  requiredMachineId,
  executorConfigs,
  machines,
}: ResolvePreferredChatLandingAgentSelectionArgs): AgentSelection | null {
  const preferredConfig = preferredAgentId
    ? executorConfigs.find((config) => config.id === preferredAgentId)
    : undefined;
  const requiredMachine = requiredMachineId ? machines.get(requiredMachineId) : undefined;
  if (requiredMachineId && !requiredMachine) {
    return null;
  }
  const preferredMachine =
    !requiredMachine && preferredMachineId ? machines.get(preferredMachineId) : undefined;
  const previousAgentType = preferredConfig?.agentType;
  const resolveSelectionForMachine = (machine: MachineViewMeta): AgentSelection | null => {
    const configsOnMachine = executorConfigs.filter((config) => config.machineId === machine.id);
    const matchByType = previousAgentType
      ? configsOnMachine.find((config) => config.agentType === previousAgentType)
      : undefined;
    const fallbackConfig = matchByType ?? configsOnMachine[0];
    return fallbackConfig ? { agentId: fallbackConfig.id, machineId: machine.id } : null;
  };

  // Exact restoration: preferred config still exists and its owning machine is
  // available (and satisfies the required-machine constraint if any).
  if (preferredConfig) {
    const ownerMachine = machines.get(preferredConfig.machineId);
    const ownerSatisfiesRequired = !requiredMachine || ownerMachine?.id === requiredMachine.id;
    if (ownerMachine && ownerSatisfiesRequired) {
      return { agentId: preferredConfig.id, machineId: ownerMachine.id };
    }
  }

  // Fallback: pick the first compatible config owned by the target machine.
  // Agent configs are per-machine, so we cannot move the stored config to a
  // different machine — we can only choose among configs that actually belong
  // to the target machine.
  const fallbackTarget =
    requiredMachine ?? preferredMachine ?? machines.get(preferredConfig?.machineId ?? '');
  if (fallbackTarget) {
    return resolveSelectionForMachine(fallbackTarget);
  }

  // Global fallback: when no stored/default target resolves, choose the first
  // machine in the caller-provided order that owns a compatible config.
  for (const machine of machines.values()) {
    const selection = resolveSelectionForMachine(machine);
    if (selection) return selection;
  }

  return null;
}

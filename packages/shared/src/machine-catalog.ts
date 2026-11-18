import { z } from 'zod';
import type { AgentConfigId, MachineId, WorkspaceId, SessionId } from './ids';
import type { AgentConfigMeta } from './schema';
import {
  parseMachineFlockRow,
  machineFlockKeys,
  type AgentConfigListSummary,
  type MachineArchiveSessionCommand,
  type MachineDeleteSessionCommand,
  type MachineDeleteLocalProjectCommand,
  type ProviderSetupCancellation,
  type ProviderSetupTask,
} from './machine-flock';
import type { LocalProjectMeta, LocalProjectId } from './project';
import type { MemoryAssociation } from './memory-provider';
import type { ManagedBuiltinAgentType } from './ai';
import { historyValuesEqual } from './history-values-equal';

export type MachineCatalogBinding = {
  readonly accountId: string;
  readonly workspaceId: WorkspaceId;
  readonly machineId: MachineId;
};
export type MachineCatalogEditor = AgentConfigListSummary & {
  readonly editToken: string;
  readonly expiresAt: number;
  readonly credentials: {
    readonly envPresent: boolean;
    readonly customLaunchPresent: boolean;
    readonly runtimeOverridesPresent: boolean;
    readonly profilePresent: boolean;
  };
  readonly hasPrompt: boolean;
  readonly credentialVerification: 'unknown';
};
const change = <T extends z.ZodType>(value: T) =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('keep') }).strict(),
    z.object({ kind: z.literal('replace'), value }).strict(),
    z.object({ kind: z.literal('clear') }).strict(),
  ]);
export const AgentConfigEditSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    description: change(z.string()).optional(),
    prompt: change(z.string()).optional(),
    env: change(z.record(z.string(), z.string())).optional(),
    envEntries: z
      .array(z.object({ name: z.string().min(1), value: change(z.string()) }).strict())
      .optional(),
    customAcp: change(z.record(z.string(), z.unknown())).optional(),
    runtimeOverrides: change(z.record(z.string(), z.unknown())).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (
      input.envEntries &&
      new Set(input.envEntries.map((entry) => entry.name)).size !== input.envEntries.length
    )
      context.addIssue({ code: 'custom', message: 'Duplicate environment key' });
    if (input.env && input.env.kind !== 'keep' && input.envEntries?.length)
      context.addIssue({ code: 'custom', message: 'Choose whole environment or per-key changes' });
    const unsafe = ['__proto__', 'constructor', 'prototype'];
    if (
      input.envEntries?.some((entry) => unsafe.includes(entry.name)) ||
      (input.env?.kind === 'replace' &&
        Object.keys(input.env.value).some((key) => unsafe.includes(key)))
    )
      context.addIssue({ code: 'custom', message: 'Invalid environment key' });
  });
export type AgentConfigEdit = z.infer<typeof AgentConfigEditSchema>;
export class MachineCatalogError extends Error {
  constructor(
    readonly code:
      | 'access_denied'
      | 'edit_conflict'
      | 'edit_expired'
      | 'not_found'
      | 'invalid_edit'
      | 'verification_required'
      | 'verification_failed'
      | 'operation_failed'
  ) {
    super(`machine_catalog_${code}`);
    this.name = 'MachineCatalogError';
  }
}

/** Shared changed-field plan. Existing opaque fields never become client input. */
export function prepareAgentConfigEdit(
  previous: AgentConfigMeta,
  input: AgentConfigEdit
): { config: AgentConfigMeta; launchChanged: boolean } {
  const parsed = AgentConfigEditSchema.safeParse(input);
  if (!parsed.success) throw new MachineCatalogError('invalid_edit');
  const edit = parsed.data;
  const next = structuredClone(previous) as AgentConfigMeta & Record<string, unknown>;
  if (edit.name !== undefined) next.name = edit.name;
  for (const field of ['description', 'prompt', 'customAcp', 'runtimeOverrides'] as const) {
    const update = edit[field];
    if (!update || update.kind === 'keep') continue;
    if (update.kind === 'clear') delete next[field];
    else next[field] = structuredClone(update.value) as never;
  }
  if (edit.env?.kind === 'clear') next.env = {};
  else if (edit.env?.kind === 'replace') next.env = { ...edit.env.value };
  for (const entry of edit.envEntries ?? []) {
    if (entry.value.kind === 'replace') next.env[entry.name] = entry.value.value;
    else if (entry.value.kind === 'clear') delete next.env[entry.name];
  }
  const normalized = parseMachineFlockRow(machineFlockKeys.agentConfig(previous.id), next);
  if (!normalized || normalized.key[0] !== 'agentConfig')
    throw new MachineCatalogError('invalid_edit');
  const config = normalized.value as AgentConfigMeta;
  if (config.machineId !== previous.machineId || config.id !== previous.id)
    throw new MachineCatalogError('invalid_edit');
  return {
    config,
    launchChanged: ['env', 'customAcp', 'runtimeOverrides', 'codexAuth', 'magpieGatewayUrl'].some(
      (key) =>
        !historyValuesEqual(
          (previous as unknown as Record<string, unknown>)[key],
          (config as unknown as Record<string, unknown>)[key]
        )
    ),
  };
}

export type MachineCatalogProjectSummary = Omit<LocalProjectMeta, 'history'>;
export type MachineCatalogProjectEdit = {
  readonly standaloneVisible?: boolean;
  readonly githubRepoFullName?:
    | { readonly kind: 'set'; readonly value: string }
    | { readonly kind: 'clear' };
};
export type MachineCatalogCommand =
  | { readonly kind: 'import-magpie'; readonly request: import('./magpie-import').MagpieImport }
  | { readonly kind: 'create-agent'; readonly config: AgentConfigMeta }
  | {
      readonly kind: 'edit-agent';
      readonly id: AgentConfigId;
      readonly editToken: string;
      readonly changes: AgentConfigEdit;
    }
  | {
      readonly kind: 'remove-agent';
      readonly id: AgentConfigId;
      readonly editToken: string;
      readonly now: number;
    }
  | { readonly kind: 'set-dot-lody-path'; readonly path: string }
  | { readonly kind: 'clear-dot-lody-path' }
  | {
      readonly kind: 'dismiss-local-project-deletion';
      readonly projectId: LocalProjectId;
      readonly completedAt: number;
    }
  | {
      readonly kind: 'invalidate-project-history-import';
      readonly projectId: LocalProjectId;
      readonly provider: import('./project').LocalProjectHistoryProvider;
      readonly sourceAcpSessionId: string;
      readonly importedSessionId: SessionId;
    }
  | { readonly kind: 'remove-session-launch-reference'; readonly sessionId: SessionId }
  | { readonly kind: 'save-local-project'; readonly project: LocalProjectMeta }
  | { readonly kind: 'ensure-local-project'; readonly project: LocalProjectMeta }
  | {
      readonly kind: 'edit-local-project';
      readonly id: LocalProjectId;
      readonly changes: MachineCatalogProjectEdit;
    }
  | { readonly kind: 'associate-memory'; readonly association: MemoryAssociation }
  | { readonly kind: 'link-memory' | 'edit-memory'; readonly association: MemoryAssociation }
  | { readonly kind: 'remove-memory'; readonly providerId: string; readonly memoryId: string }
  | {
      readonly kind: 'archive-session';
      readonly sessionId: SessionId;
      readonly command: MachineArchiveSessionCommand;
    }
  | {
      readonly kind: 'delete-session';
      readonly sessionId: SessionId;
      readonly command: MachineDeleteSessionCommand;
    }
  | {
      readonly kind: 'delete-local-project';
      readonly projectId: LocalProjectId;
      readonly command: MachineDeleteLocalProjectCommand;
    }
  | { readonly kind: 'queue-provider-setup'; readonly task: ProviderSetupTask }
  | {
      readonly kind: 'retry-provider-setup';
      readonly id: AgentConfigId;
      readonly expected: Pick<ProviderSetupTask, 'attempt' | 'status' | 'updatedAt'>;
      readonly now: number;
    }
  | { readonly kind: 'cancel-provider-setup'; readonly cancellation: ProviderSetupCancellation }
  | {
      readonly kind: 'set-builtin-opt-out';
      readonly agentType: ManagedBuiltinAgentType;
      readonly removedAt: number;
    };

export function assertMachineCatalogBinding(
  expected: MachineCatalogBinding,
  actual: MachineCatalogBinding
) {
  if (
    expected.accountId !== actual.accountId ||
    expected.workspaceId !== actual.workspaceId ||
    expected.machineId !== actual.machineId
  )
    throw new MachineCatalogError('access_denied');
}

/** Bound management capability; replies contain no saved credential values. */
export interface AgentConfigEditorPort {
  load(id: AgentConfigId): Promise<MachineCatalogEditor>;
  save(
    input: {
      readonly id: AgentConfigId;
      readonly editToken: string;
      readonly changes: AgentConfigEdit;
    },
    options?: { readonly signal?: AbortSignal }
  ): Promise<{ readonly changed: boolean }>;
}

export type ProviderSetupSummary = Omit<ProviderSetupTask, 'config'> & {
  readonly config: AgentConfigListSummary;
};
export type MachineCatalogCommandResult = {
  readonly changed: boolean;
  readonly association?: MemoryAssociation;
  readonly project?: MachineCatalogProjectSummary;
};
/** Complete safe provider snapshot for the existing settings surface. The
 * composition owns observation; this port must not wrap a renderer Flock copy. */
export interface MachineCatalogSettingsPort {
  readonly binding: Pick<MachineCatalogBinding, 'accountId' | 'workspaceId'>;
  readonly generation: string;
  /** A single-machine authority change must not discard other machines' drafts. */
  machineGeneration?(machineId: MachineId): string;
  readonly agents: readonly AgentConfigListSummary[];
  readonly setups: readonly ProviderSetupSummary[];
  readonly dotlodyPaths?: Readonly<Record<string, string | undefined>>;
  editor(machineId: MachineId): AgentConfigEditorPort;
  execute(
    machineId: MachineId,
    command: MachineCatalogCommand
  ): Promise<MachineCatalogCommandResult>;
}

/** Public capabilities were checked against the saved private provider by Node.
 * They carry no sourceVersion, runtime overrides or credential-bearing config. */
export type MachineCatalogPublicCapability = Pick<
  import('./ai').AcpCapabilityCacheEntry,
  | 'cliType'
  | 'agentType'
  | 'modes'
  | 'models'
  | 'configOptions'
  | 'availableCommands'
  | 'modelReasoningEfforts'
  | 'declaredModelControls'
  | 'observedModelConfigOptions'
  | 'sessionFork'
  | 'sessionForkWorktree'
  | 'sessionTitle'
  | 'acknowledgedSteer'
  | 'goalActions'
> & {
  readonly authority: import('./ai').AcpCapabilityAuthority;
  readonly canValidateRolePins: boolean;
  readonly optionCoverage?: {
    readonly complete: boolean;
    readonly withheldOptionIds: readonly string[];
  };
};
export type MachineCatalogQuotaEligibility = {
  readonly subscription: boolean;
  readonly query: boolean;
  readonly resetForecast: boolean;
};

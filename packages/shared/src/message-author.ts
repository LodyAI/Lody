import { z } from 'zod';
import {
  ACP_FAST_MODE_CONFIG_IDS,
  ACP_CONFIG_OPTION_ON_VALUE,
  ACP_CONFIG_OPTION_OFF_VALUE,
} from './acp-run-config';
import { AGENT_BRAND_IDS, type AgentBrandId } from './agent-brand';
import { getAgentRoleEmoji, type AgentRole } from './agent-role';
import type { AgentConfigCliType, ModelInfo, SessionTurnInputConfig } from './ai';

const id = z.string().trim().min(1).max(256);
const label = z.string().trim().min(1).max(256);

export const AgentRoleSnapshotSchema = z.object({
  id,
  revision: z.number().int().nonnegative(),
  name: label,
  emoji: z.string().max(64),
});
export type AgentRoleSnapshot = z.infer<typeof AgentRoleSnapshotSchema>;
export const snapshotAgentRole = (
  role: Pick<AgentRole, 'id' | 'revision' | 'name' | 'emoji'>
): AgentRoleSnapshot =>
  AgentRoleSnapshotSchema.parse({
    id: role.id,
    revision: role.revision,
    name: role.name,
    emoji: getAgentRoleEmoji(role),
  });

/** Presentation/provenance only. Never an authorization principal or dispatch config. */
export const AgentMessageAuthorSchema = z.object({
  v: z.literal(1),
  kind: z.literal('agent'),
  sessionId: id,
  turnId: id,
  agentConfigId: id.optional(),
  cliType: z.enum(['builtin', 'registry', 'custom']).optional(),
  agentType: label.optional(),
  brandId: z.enum(AGENT_BRAND_IDS).optional(),
  name: label,
  role: AgentRoleSnapshotSchema.optional(),
  model: z
    .object({ id: label, name: label.optional(), source: z.enum(['configured', 'runtime']) })
    .optional(),
  reasoningEffort: label.optional(),
  fastMode: z.boolean().optional(),
  planMode: z.boolean().optional(),
});

export const MessageAuthorSchema = z.discriminatedUnion('kind', [
  z.object({ v: z.literal(1), kind: z.literal('human'), userId: id }),
  AgentMessageAuthorSchema,
  z.object({ v: z.literal(1), kind: z.literal('system') }),
]);
export type MessageAuthor = z.infer<typeof MessageAuthorSchema>;
export type AgentMessageAuthor = z.infer<typeof AgentMessageAuthorSchema>;

const short = (value: string | undefined): string | undefined =>
  value?.trim().slice(0, 256) || undefined;

const UUID_PREFIX_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\//i;

const decodePercentSegment = (value: string): string => {
  if (!value.includes('%')) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export function formatAgentModelIdFallback(modelId: string): string {
  const trimmed = modelId.trim();
  if (!trimmed) return modelId;
  const withoutUuidPrefix = UUID_PREFIX_RE.test(trimmed)
    ? trimmed.slice(trimmed.indexOf('/') + 1)
    : trimmed;
  const decoded = decodePercentSegment(withoutUuidPrefix).trim();
  return decoded || trimmed;
}

export function formatAgentAuthorModelDisplayName(
  model: Pick<NonNullable<AgentMessageAuthor['model']>, 'id' | 'name'>
): string {
  const rawName = model.name?.trim();
  const candidate =
    rawName && rawName !== model.id.trim() ? rawName : formatAgentModelIdFallback(model.id);
  return candidate.replace(/\s*\(recommended\)/gi, '').trim() || model.id;
}

export function enrichAgentMessageAuthorModel(
  author: AgentMessageAuthor,
  modelInfo?: Pick<ModelInfo, 'modelId' | 'name'>,
  fallbackModelName?: string
): AgentMessageAuthor {
  const runtimeId = short(modelInfo?.modelId);
  const resolvedFallback = short(fallbackModelName);
  if (runtimeId) {
    const runtimeName = short(modelInfo?.name);
    const existingSameModelName =
      author.model?.id === runtimeId &&
      author.model.name &&
      author.model.name !== author.model.id
        ? author.model.name
        : undefined;
    const resolvedName =
      runtimeName && runtimeName !== runtimeId
        ? runtimeName
        : (resolvedFallback ?? existingSameModelName ?? runtimeName);
    const shouldUpgrade =
      !author.model ||
      author.model.source === 'configured' ||
      (author.model.id === runtimeId &&
        Boolean(resolvedName) &&
        (!author.model.name || author.model.name === author.model.id) &&
        resolvedName !== author.model.name);
    if (!shouldUpgrade) return author;
    return AgentMessageAuthorSchema.parse({
      ...author,
      model: {
        id: runtimeId,
        ...(resolvedName ? { name: resolvedName } : {}),
        source: 'runtime',
      },
    });
  }
  if (
    author.model &&
    resolvedFallback &&
    (!author.model.name || author.model.name === author.model.id) &&
    resolvedFallback !== author.model.name
  ) {
    return AgentMessageAuthorSchema.parse({
      ...author,
      model: {
        ...author.model,
        name: resolvedFallback,
      },
    });
  }
  return author;
}

/** Explicit allowlist: never spread launch config, option dictionaries or model _meta. */
export function buildAgentMessageAuthor(input: {
  sessionId: string;
  turnId: string;
  agentConfigId?: string;
  cliType?: AgentConfigCliType;
  agentType?: string;
  name?: string;
  brandId?: AgentBrandId;
  inputConfig?: SessionTurnInputConfig;
  modelInfo?: Pick<ModelInfo, 'modelId' | 'name'>;
  modelName?: string;
  role?: AgentRoleSnapshot;
}): AgentMessageAuthor {
  const config = input.inputConfig;
  const options = config?.configOptionValues;
  const stringOption = (...keys: string[]) =>
    keys.map((key) => options?.[key]).find((v): v is string => typeof v === 'string');
  const booleanOption = (...keys: string[]) =>
    keys
      .map((key) => options?.[key])
      .map((v) =>
        v === ACP_CONFIG_OPTION_ON_VALUE ? true : v === ACP_CONFIG_OPTION_OFF_VALUE ? false : v
      )
      .find((v): v is boolean => typeof v === 'boolean');
  const runtimeModelId = short(input.modelInfo?.modelId);
  const modelId = runtimeModelId ?? short(config?.modelId ?? stringOption('model'));
  const runtimeModelName = short(input.modelInfo?.name);
  const fallbackModelName = short(input.modelName);
  const modelName =
    runtimeModelName && runtimeModelName !== modelId
      ? runtimeModelName
      : (fallbackModelName ?? runtimeModelName);
  const reasoningEffort = short(
    stringOption('reasoning_effort', 'reasoning', 'effort', 'thought_level')
  );
  const fastMode = booleanOption(...ACP_FAST_MODE_CONFIG_IDS);
  const planMode =
    booleanOption('plan_mode') ??
    (options?.collaboration_mode === 'plan' || config?.modeId === 'plan'
      ? true
      : options?.collaboration_mode === 'default'
        ? false
        : undefined);
  return AgentMessageAuthorSchema.parse({
    v: 1,
    kind: 'agent',
    sessionId: input.sessionId,
    turnId: input.turnId,
    ...(input.agentConfigId ? { agentConfigId: input.agentConfigId } : {}),
    ...(input.cliType ? { cliType: input.cliType } : {}),
    ...(short(input.agentType) ? { agentType: short(input.agentType) } : {}),
    ...(input.brandId ? { brandId: input.brandId } : {}),
    name: short(input.name) ?? short(input.agentType) ?? 'Agent',
    ...(input.role
      ? {
          role: {
            id: input.role.id,
            revision: input.role.revision,
            name: short(input.role.name),
            emoji: getAgentRoleEmoji(input.role),
          },
        }
      : {}),
    ...(modelId
      ? {
          model: {
            id: modelId,
            ...(modelName ? { name: modelName } : {}),
            source: runtimeModelId ? 'runtime' : 'configured',
          },
        }
      : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(fastMode !== undefined ? { fastMode } : {}),
    ...(planMode !== undefined ? { planMode } : {}),
  });
}

/** Tolerant read: future snapshots are left stored, never mistaken for a human. */
export function readMessageAuthor(value: unknown): MessageAuthor | undefined {
  const result = MessageAuthorSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

/**
 * The header an agent receives in front of another agent's message. Derived from
 * the recorded author at execution time, never stored, so relayed text cannot
 * claim human authority. Human and system inputs get no header.
 */
export function formatAgentSenderHeader(author: AgentMessageAuthor, sourceTitle?: string): string {
  const source = sourceTitle ? `"${sourceTitle}" (${author.sessionId})` : author.sessionId;
  const agent = [author.name, author.role ? `Agent Role "${author.role.name}"` : undefined]
    .filter(Boolean)
    .join(' · ');
  return [
    '[Lody] This message was sent by another agent, not by a human.',
    `Source Session: ${source}${agent ? `, ${agent}` : ''}`,
  ].join('\n');
}

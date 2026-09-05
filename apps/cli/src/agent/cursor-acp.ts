import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import type { AcpConfigOptionSummary, AgentConfigCliType } from '@lody/shared';
import { z } from 'zod';

import { normalizeConfigOptions } from '@/agent/acp-capability-normalization';
import { isAcpMethodNotFoundError, type AgentClient } from '@/agent/agent-client';
import { formatErrorMessage } from '@/utils/format-error';
import type { Logger } from '@/utils/logger';

export const CURSOR_LIST_AVAILABLE_MODELS_METHOD = 'cursor/list_available_models';

/**
 * Identity, not command line, decides the opt-in: a custom or builtin config that
 * happens to launch the same binary keeps standard ACP behaviour.
 */
export const isRegistryCursorAgent = (identity: {
  cliType: AgentConfigCliType | null | undefined;
  agentType: string | null | undefined;
}): boolean => identity.cliType === 'registry' && identity.agentType === 'cursor';

export type FetchCursorModelCatalogParams = {
  client: Pick<AgentClient, 'requestExtMethod'>;
  signal?: AbortSignal;
  timeoutMs?: number;
  logger?: Logger;
};

const cursorSelectOptionSchema = z.looseObject({
  value: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
});

const cursorSelectGroupSchema = z.looseObject({
  group: z.string(),
  name: z.string(),
  options: z.array(cursorSelectOptionSchema),
});

const cursorSelectConfigOptionSchema = z.looseObject({
  type: z.literal('select'),
  id: z.string().min(1),
  name: z.string(),
  description: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  currentValue: z.string(),
  options: z.array(z.union([cursorSelectOptionSchema, cursorSelectGroupSchema])),
});

const cursorBooleanConfigOptionSchema = z.looseObject({
  type: z.literal('boolean'),
  id: z.string().min(1),
  name: z.string(),
  description: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  currentValue: z.boolean(),
});

const cursorConfigOptionSchema = z.discriminatedUnion('type', [
  cursorSelectConfigOptionSchema,
  cursorBooleanConfigOptionSchema,
]);

const cursorListAvailableModelsResponseSchema = z.looseObject({
  models: z.array(
    z.looseObject({
      value: z.string().min(1),
      name: z.string().optional(),
      configOptions: z.array(cursorConfigOptionSchema),
    })
  ),
});

const INCOMPLETE_PREFIX = '[ACP_CAPABILITIES_INCOMPLETE]';

/**
 * Fetches registry Cursor's per-model option catalog via `cursor/list_available_models`.
 * JSON-RPC `-32601` means the method is absent and returns `undefined`.
 * Any other failure, including validation, timeout, or abort, throws `[ACP_CAPABILITIES_INCOMPLETE]`.
 * Options whose category is `model` or `mode` are dropped after normalization.
 */
export async function fetchCursorModelCatalog(
  params: FetchCursorModelCatalogParams
): Promise<Record<string, AcpConfigOptionSummary[]> | undefined> {
  const { client, signal, timeoutMs = 15_000, logger } = params;
  signal?.throwIfAborted();
  const combined = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]);
  try {
    const raw = await client.requestExtMethod(
      CURSOR_LIST_AVAILABLE_MODELS_METHOD,
      {},
      { signal: combined }
    );
    const parsed = cursorListAvailableModelsResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `${INCOMPLETE_PREFIX} cursor/list_available_models response failed validation: ${parsed.error.message}`
      );
    }
    const configOptionsByModel: Record<string, AcpConfigOptionSummary[]> = {};
    for (const entry of parsed.data.models) {
      if (Object.hasOwn(configOptionsByModel, entry.value)) {
        throw new Error(
          `${INCOMPLETE_PREFIX} cursor/list_available_models listed model ${entry.value} more than once`
        );
      }
      const normalized =
        // Parsed configOptions match the ACP SessionConfigOption shape.
        normalizeConfigOptions(entry.configOptions as SessionConfigOption[]) ?? [];
      configOptionsByModel[entry.value] = normalized.filter(
        (option) => option.category !== 'model' && option.category !== 'mode'
      );
    }
    return configOptionsByModel;
  } catch (error) {
    if (isAcpMethodNotFoundError(error)) {
      logger?.debug(`cursor/list_available_models is unavailable: ${formatErrorMessage(error)}`);
      return undefined;
    }
    if (combined.aborted) {
      throw new Error(
        `${INCOMPLETE_PREFIX} cursor/list_available_models timed out or was aborted`,
        { cause: error }
      );
    }
    if (error instanceof Error && error.message.startsWith(INCOMPLETE_PREFIX)) {
      throw error;
    }
    throw new Error(
      `${INCOMPLETE_PREFIX} cursor/list_available_models failed: ${formatErrorMessage(error)}`,
      { cause: error }
    );
  }
}

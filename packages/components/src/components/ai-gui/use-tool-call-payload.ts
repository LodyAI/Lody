import type { ToolCallPayload, ToolCallRef } from '@lody/shared';

export type ToolCallPayloadState = 'idle' | 'loading' | 'ready' | 'unavailable';

export type ToolCallPayloadResult = {
  state: ToolCallPayloadState;
  value?: ToolCallPayload;
};

const UNAVAILABLE: ToolCallPayloadResult = { state: 'unavailable' };

/**
 * Resolves the execution payload (`content`/`rawInput`/`rawOutput`) of a
 * sealed tool_call skeleton from the origin machine named by `ref`.
 *
 * The Machine RPC that backs this arrives in a later task; until then every
 * lookup reports `unavailable`, so readers render the skeleton (title,
 * locations) with a placeholder instead of the payload. The fetch will wire
 * in here without changing this signature or its callers.
 */
export const useToolCallPayload = (ref: ToolCallRef | undefined): ToolCallPayloadResult => {
  void ref;
  return UNAVAILABLE;
};

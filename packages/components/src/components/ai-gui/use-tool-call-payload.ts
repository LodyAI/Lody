import type { ToolCallPayload, ToolCallRef } from '@lody/shared';

export type ToolCallPayloadState = 'idle' | 'loading' | 'ready' | 'unavailable';

export type ToolCallPayloadResult = {
  state: ToolCallPayloadState;
  value?: ToolCallPayload;
};

const UNAVAILABLE: ToolCallPayloadResult = { state: 'unavailable' };

/**
 * Resolves the execution payload (`content`/`rawInput`/`rawOutput`) of a sealed
 * tool_call skeleton from the origin machine named by `ref`.
 *
 * Scope: this round only makes a ref-only skeleton readable. The Machine RPC
 * that fetches the payload is NOT implemented, so every lookup reports
 * `unavailable` and readers render the skeleton (title, kind, status,
 * locations) with a "stored on <machine>" row instead of the payload. When the
 * fetch lands it wires in here without changing this signature or its callers.
 */
export const useToolCallPayload = (ref: ToolCallRef | undefined): ToolCallPayloadResult => {
  void ref;
  return UNAVAILABLE;
};

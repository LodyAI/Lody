/** Narrow dispatch intent; the target validates inputConfig with its existing turn codec. */
export type E2eeDispatchInput = {
  sessionId: string;
  userTurnId: string;
  userId: string;
  timestamp: string;
  inputConfig: unknown;
};
/** Public original ciphertext receipt. No key or execution authority crosses the host boundary. */
export type E2eePreparedDispatch = {
  requestId: string;
  targetMachineId: string;
  frameHex: string;
  /** Feature requests only: ordered, individually signed chunks of one original. */
  frames?: string[];
  requesterDevice: string;
  expiresAt: number;
};
/** Delivery receipt only. Actual execution remains behind the shared agent-start claim. */
export type E2eeDispatchAck = {
  type: 'session/dispatch-turn_response';
  sessionId: string;
  userTurnId: string;
  accepted: boolean;
  disposition: 'accepted' | 'duplicate' | 'already-terminal' | 'not-owned' | 'error';
};

import { z } from 'zod';
import { LocalMachineRpcRequestSchema, type LocalMachineRpcRequest } from './local-machine-rpc';

/** Network access stays restricted to the existing file and preview product surfaces. */
export const isE2eeFeatureMethod = (method: string): boolean =>
  method.startsWith('code-collab/') ||
  method === 'file/preview' ||
  method === 'session/preview-create' ||
  method === 'session/preview-revoke' ||
  method === 'session/preview-status';
export const E2eeFeatureInputSchema = z
  .object({
    requestId: z.string().regex(/^[0-9a-f]{32}$/),
    request: LocalMachineRpcRequestSchema.refine((request) => isE2eeFeatureMethod(request.method)),
  })
  .strict();
export type E2eeFeatureInput = { requestId: string; request: LocalMachineRpcRequest };
export type E2eeFeatureResponsePart = { sequence: number; final: boolean; bytes: Uint8Array };

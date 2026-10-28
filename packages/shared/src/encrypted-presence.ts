import { z } from 'zod';
import {
  LodyPresenceStateSchema,
  getLodyMachinePresenceKey,
  getLodySessionPresenceKey,
  getLodySessionViewingPresenceKey,
  type LodyPresenceState,
} from './presence';

/** Short-lived authenticated state. The host reconstructs the author namespace. */
export type EncryptedPresenceEntry = {
  key: string;
  state: LodyPresenceState | null;
  expiresAt: number;
};
/** Purpose-limited host capability. No caller-selected room, key, signer or arbitrary plaintext. */
export type EncryptedPresencePort = {
  /** Verified ledger changes retire cached receipts and in-flight projections. */
  subscribeInvalidation?(listener: () => void): () => void;
  seal(input: { key: string; state: LodyPresenceState | null }): Promise<Uint8Array>;
  open(frame: Uint8Array): Promise<EncryptedPresenceEntry | null>;
};
export const ENCRYPTED_PRESENCE_TTL_MS = 60_000;
export const ENCRYPTED_PRESENCE_MAX_BYTES = 4096;
const identifier = z.string().min(1).max(128);
/** Validate the existing liveness DTO plus encrypted-channel bounds before serialization. */
export function parseEncryptedPresencePublication(value: unknown) {
  const parsed = z
    .object({ key: z.string().min(1).max(1024), state: LodyPresenceStateSchema.nullable() })
    .parse(value);
  const state = parsed.state;
  if (state) {
    identifier.parse(state.instanceId);
    if (state.kind === 'session-viewing') {
      identifier.parse(state.sessionId);
      identifier.parse(state.userId);
    } else {
      identifier.parse(state.machineId);
      if (state.kind === 'session') identifier.parse(state.sessionId);
    }
    const expected =
      state.kind === 'machine'
        ? getLodyMachinePresenceKey(state.machineId, state.instanceId)
        : state.kind === 'session'
          ? getLodySessionPresenceKey(state.sessionId, state.instanceId)
          : getLodySessionViewingPresenceKey(state.userId, state.instanceId);
    if (parsed.key !== expected) throw new Error('e2ee_presence_invalid');
  } else if (!/^(machine|session|viewing):[^:]{1,384}:[^:]{1,384}$/.test(parsed.key))
    throw new Error('e2ee_presence_invalid');
  return parsed;
}

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

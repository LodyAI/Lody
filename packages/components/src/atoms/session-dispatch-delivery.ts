import { atom } from 'jotai';

/**
 * User turns acked by the machine over the `session/dispatch-turn` fast path
 * or Roost immutable owner acceptance, keyed `${sessionId}:${userTurnId}`.
 *
 * Transient client-side delivery overlay: the entry's durable CRDT status
 * stays `pending` until the machine can see the history entry, so without
 * this the sender would keep showing "Sending" even though the machine
 * already acked (and likely started) the turn. The durable status flip
 * replaces the overlay's job once it syncs back; we never fake the CRDT
 * status itself.
 */
export const rpcDeliveredTurnsAtom = atom<ReadonlySet<string>>(new Set<string>());

export const getRpcDeliveredTurnKey = (sessionId: string, userTurnId: string): string =>
  `${sessionId}:${userTurnId}`;

const RPC_DELIVERED_TURN_LIMIT = 200;

/** Add a delivered turn, trimming the oldest keys so the set stays bounded. */
export const addRpcDeliveredTurn = (
  previous: ReadonlySet<string>,
  key: string
): ReadonlySet<string> => {
  const next = new Set(previous);
  next.add(key);
  while (next.size > RPC_DELIVERED_TURN_LIMIT) {
    const oldest = next.values().next().value;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  return next;
};

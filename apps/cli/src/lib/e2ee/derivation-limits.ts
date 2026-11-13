/**
 * Bounds on inputs derived from a shared member's encrypted Turn (owner decision
 * 2026-10-31). Kept dependency-free so ordinary session code can import it.
 * Twenty matches the largest single Agent batch (twenty targets).
 */
export const MAX_DERIVED_TURNS_PER_ORIGIN = 20;

/**
 * Write-time decision for an Agent-delegated encrypted input. `live` is the active
 * driving turn's principal (undefined when inactive);
 * `verified` is its signed root's current classification. Owner work keeps today's
 * behavior, including recovery after its turn ended. A shared member's
 * derivation must come from its active driving turn and stay on this machine.
 * Every member descendant shares the root's durable start quota; Owner work is unbounded.
 */
export function decideEncryptedDerivation(input: {
  readonly live: 'owner' | 'member' | undefined;
  readonly verified: 'owner' | 'member' | 'denied';
  readonly targetMachineId: string;
  readonly machineId: string;
}): 'owner' | 'member' {
  if (input.live === 'owner' && input.verified === 'owner') return 'owner';
  if (input.verified === 'owner' && input.live === undefined) return 'owner';
  if (input.verified === 'member' && input.live === 'member') {
    if (input.targetMachineId !== input.machineId)
      throw new Error('e2ee_derivation_cross_machine_unsupported');
    return 'member';
  }
  throw new Error('e2ee_derivation_denied');
}

/**
 * Bounds on inputs derived from a shared member's encrypted Turn (owner decision
 * 2026-10-31). Kept dependency-free so ordinary session code can import it.
 * Twenty matches the largest single Agent batch (twenty targets).
 */
export const MAX_DERIVED_TURNS_PER_ORIGIN = 20;
/** A derived input must start no later than this after its origin's signed deadline. */
export const DERIVED_START_GRACE_MS = 15 * 60_000;

/**
 * Write-time decision for an Agent-delegated encrypted input. `live` is the active
 * driving turn's reserved principal (undefined when inactive or over the bound);
 * `verified` is its signed origin's classification. Owner work keeps today's
 * behavior, including recovery after its turn ended. A shared member's
 * derivation must come from its active turn and stay on this machine.
 */
export function decideEncryptedDerivation(input: {
  readonly live: 'owner' | 'member' | undefined;
  readonly verified: 'owner' | 'member' | 'denied';
  readonly targetMachineId: string;
  readonly machineId: string;
}): 'owner' | 'member' {
  if (input.live === 'owner') return 'owner';
  if (input.verified === 'owner' && input.live === undefined) return 'owner';
  if (input.verified === 'member' && input.live === 'member') {
    if (input.targetMachineId !== input.machineId)
      throw new Error('e2ee_derivation_cross_machine_unsupported');
    return 'member';
  }
  throw new Error('e2ee_derivation_denied');
}

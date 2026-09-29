import { normalizeSessionTurnInputConfig, type SessionHistory } from '@lody/shared';

export type GuideTurnOutcome = 'applied' | 'not-applied' | 'uncertain';

/**
 * What the guide's own history row proves once the daemon answered, or after
 * its answer was lost. `pending_apply` and `delivery_unknown` prove nothing:
 * replaying either could run the input twice.
 */
export function readGuideTurnOutcome(
  read: { state: 'ready'; turn: Pick<SessionHistory, 'status' | 'inputConfig'> } | { state: string }
): GuideTurnOutcome {
  if (read.state !== 'ready' || !('turn' in read)) return 'uncertain';
  const status = read.turn.status;
  if (!status || status === 'pending_apply' || status === 'delivery_unknown') return 'uncertain';
  return normalizeSessionTurnInputConfig(read.turn.inputConfig)?._lodyDeliveryKind === 'steer'
    ? 'applied'
    : 'not-applied';
}

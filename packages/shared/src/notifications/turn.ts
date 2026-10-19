import type { SessionId } from '../ids';
import type { AttentionItem, NotificationScope } from './index';

/** Frozen by the execution owner, never inferred from Session containment. */
export type TurnResultAudience =
  | { readonly kind: 'user' }
  | {
      readonly kind: 'agent';
      readonly sessionId: SessionId;
      readonly turnId: string;
    }
  | { readonly kind: 'unknown' };

export type TurnOutcome =
  | { readonly kind: 'succeeded' }
  | { readonly kind: 'failed'; readonly code: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'unknown'; readonly code: string };

/** An internal execution fact. No message bodies or device selection. */
export type TurnOutcomeFact = {
  readonly scope: NotificationScope;
  readonly sessionId: SessionId;
  readonly turnId: string;
  readonly audience: TurnResultAudience;
  readonly outcome: TurnOutcome;
  readonly originTurnIds?: readonly string[];
};

/** Keep the deployed provider tuple stable across refactors and copy changes. */
export function turnOutcomeKey(fact: {
  scope: { workspaceId: string; recipientId: string };
  sessionId: string;
  turnId: string;
}): string {
  return JSON.stringify([
    'turn',
    fact.scope.workspaceId,
    fact.scope.recipientId,
    fact.sessionId,
    fact.turnId,
  ]);
}

/**
 * One terminal fact per logical input turn. A retry of notification processing
 * cannot create a new episode. A new execution must have its own input identity.
 * Unknown provenance is retained for diagnosis, never guessed to be human work.
 */
export function projectTurnAttention(fact: TurnOutcomeFact): AttentionItem | null {
  if (fact.audience.kind !== 'user' || fact.outcome.kind === 'cancelled') return null;
  return {
    id: turnOutcomeKey(fact),
    scope: { ...fact.scope },
    source: {
      kind: 'session',
      sessionId: fact.sessionId,
      turnId: fact.turnId,
      ...(fact.originTurnIds ? { originTurnIds: [...fact.originTurnIds] } : {}),
    },
    outcome: fact.outcome.kind,
  };
}

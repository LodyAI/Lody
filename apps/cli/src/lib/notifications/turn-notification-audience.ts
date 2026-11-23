import { readMessageAuthor, type SessionId } from '@lody/shared';
import type { TurnResultAudience } from '@lody/shared/notifications';

/** Only call with the exact persisted input; an absent RPC input is unknown. */
export function turnNotificationAudience(authorInput: unknown): TurnResultAudience {
  const author = readMessageAuthor(authorInput);
  if (author?.kind === 'agent')
    return { kind: 'agent', sessionId: author.sessionId as SessionId, turnId: author.turnId };
  if (author?.kind === 'system' || (authorInput !== undefined && !author))
    return { kind: 'unknown' };
  return { kind: 'user' };
}

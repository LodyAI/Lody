import { z } from 'zod';
import type { SessionId, WorkspaceId } from '../ids';

export { projectTurnAttention, turnOutcomeKey } from './turn';
export type { TurnOutcome, TurnOutcomeFact, TurnResultAudience } from './turn';

export type NotificationScope = {
  readonly workspaceId: WorkspaceId;
  readonly recipientId: string;
};

export const terminalOutcomeSchema = z.enum(['succeeded', 'failed', 'unknown']);
export type TerminalOutcome = z.infer<typeof terminalOutcomeSchema>;

/** Latest desktop projection; additive wire shape shared by writer and reader.
 * The UUID is an activation index, not a durable delivery receipt or queue.
 */
export const terminalNotificationSchema = z.object({
  id: z.string().uuid(),
  recipientId: z.string().min(1).max(256),
  turnId: z.string().min(1).max(256),
  outcome: terminalOutcomeSchema,
  createdAt: z.number().finite(),
});
export type TerminalNotification = z.infer<typeof terminalNotificationSchema>;

/** A source-owned reason to notify. Inbox can consume this later; no separate
 * item store, revision engine or generic delivery framework is needed today.
 * Schedules use their ordinary Session turn and the same policy.
 */
export type AttentionItem = {
  readonly id: string;
  readonly scope: NotificationScope;
  readonly source: {
    readonly kind: 'session';
    readonly sessionId: SessionId;
    readonly turnId: string;
  };
  readonly outcome: TerminalOutcome;
};

import type { Effect } from 'effect';
import type { InboxScope } from './model';

export interface InboxQueries {
  preferredHumanInput(
    workspaceId: string,
    sessionId: string
  ): Effect.Effect<string | undefined, unknown>;
  inputCancellationReason(
    workspaceId: string,
    sessionId: string,
    id: string
  ): Effect.Effect<'user_stop' | undefined, unknown>;
  inputEnded(workspaceId: string, sessionId: string, id: string): Effect.Effect<boolean, unknown>;
  inputCanceled(
    workspaceId: string,
    sessionId: string,
    id: string
  ): Effect.Effect<boolean, unknown>;
  inputKind(
    scope: InboxScope,
    id: string
  ): Effect.Effect<'human' | 'task' | 'automation' | undefined, unknown>;
  pauseTarget(
    workspaceId: string,
    sessionId: string,
    id: string
  ): Effect.Effect<(InboxScope & { executionId: string }) | undefined, unknown>;
}

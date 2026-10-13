import type { Effect } from 'effect';
import type { InboxScope } from './model';

export interface InboxQueries {
  preferredHumanInput(
    workspaceId: string,
    sessionId: string
  ): Effect.Effect<string | undefined, unknown>;
  inputCanceled(
    workspaceId: string,
    sessionId: string,
    id: string
  ): Effect.Effect<boolean, unknown>;
  inputKind(scope: InboxScope, id: string): Effect.Effect<'human' | 'task' | undefined, unknown>;
  pauseTarget(
    workspaceId: string,
    sessionId: string,
    id: string
  ): Effect.Effect<(InboxScope & { executionId: string }) | undefined, unknown>;
}

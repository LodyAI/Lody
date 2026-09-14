import { Context, Data, Effect, type Scope } from 'effect';
import type { SessionId, SessionTurnInputConfig, SessionSteerResponse } from '@lody/shared';

export type SteerTurn = {
  id: string;
  userId: string;
  timestamp: string;
  inputConfig: SessionTurnInputConfig;
};

export class StaleTurn extends Data.TaggedError('StaleTurn')<{
  disposition: 'no-active-turn' | 'stale-turn' | 'busy';
  message: string;
}> {}

/** Only a proven refusal before injection permits ordinary dispatch. */
export class ProviderRejected extends Data.TaggedError('ProviderRejected')<{
  disposition: Exclude<SessionSteerResponse['disposition'], 'applied'>;
  message: string;
}> {}

export class ProviderDeliveryUnknown extends Data.TaggedError('ProviderDeliveryUnknown')<{
  message: string;
  cause?: unknown;
}> {}

export class PersistenceFailure extends Data.TaggedError('PersistenceFailure')<{
  message: string;
  cause: unknown;
}> {}

/** Preparation failed before steer submission; the frozen turn may become ordinary dispatch. */
export class SteerPreparationFailure extends Data.TaggedError('SteerPreparationFailure')<{
  message: string;
  cause: unknown;
}> {}

/** Opaque, single-use handle; execution state stays with the live-turn owner. */
export class PreparedSteer extends Data.TaggedClass('PreparedSteer')<{}> {}

export type NativeSteerFailure = StaleTurn | ProviderRejected | ProviderDeliveryUnknown;
export type NativeSteerInput = {
  sessionId: SessionId;
  expectedTurnId: string;
  turn: SteerTurn;
};

/** Operations run inside the execution owner's per-session serialization boundary. */
export class ActiveTurnSteerPort extends Context.Tag('lody/ActiveTurnSteerPort')<
  ActiveTurnSteerPort,
  {
    guard(sessionId: SessionId): Effect.Effect<void, StaleTurn, Scope.Scope>;
    inspect(
      sessionId: SessionId,
      expectedTurnId: string
    ): Effect.Effect<{ native: boolean; requesterUserId: string }, StaleTurn | ProviderRejected>;
    prepareSteer(
      input: NativeSteerInput
    ): Effect.Effect<PreparedSteer, StaleTurn | ProviderRejected | SteerPreparationFailure>;
    submitSteer(prepared: PreparedSteer): Effect.Effect<{ userTurnId: string }, NativeSteerFailure>;
    cancel(sessionId: SessionId, expectedTurnId: string): Effect.Effect<void, ProviderRejected>;
    ownsPrompt(sessionId: SessionId, expectedTurnId: string): boolean;
    activeUserTurnId(sessionId: SessionId): string | undefined;
  }
>() {}

import { randomUUID } from 'node:crypto';
import { Deferred, Effect, Option } from 'effect';
import {
  invocationDeadlineMs,
  lostInvocationCode,
  type PluginInvocationKind,
} from '../pure/call-policy';

export interface InvocationFailure {
  readonly code: string;
  readonly message: string;
}

/** A generation owns its own reply table; a late result cannot reach a successor. */
export function makePluginInvocations() {
  const pending = new Map<
    string,
    { kind: PluginInvocationKind; reply: Deferred.Deferred<unknown, InvocationFailure> }
  >();
  let closed = false;
  const invoke = Effect.fn('PluginHost.invoke')(function* (
    kind: PluginInvocationKind,
    send: (id: string) => Effect.Effect<void, InvocationFailure>,
    cancel: (id: string) => Effect.Effect<void>
  ) {
    const id = randomUUID();
    const reply = yield* Deferred.make<unknown, InvocationFailure>();
    if (closed)
      return yield* Effect.fail({ code: 'plugin_faulted', message: 'Plugin process exited' });
    pending.set(id, { kind, reply });
    return yield* Effect.gen(function* () {
      const result = yield* send(id).pipe(
        Effect.andThen(Deferred.await(reply)),
        Effect.timeoutOption(invocationDeadlineMs(kind))
      );
      if (Option.isSome(result)) return result.value;
      yield* cancel(id);
      return yield* Effect.fail({
        code: lostInvocationCode(kind, 'timeout'),
        message: 'Plugin invocation timed out',
      });
    }).pipe(
      Effect.onInterrupt(() => cancel(id)),
      Effect.ensuring(Effect.sync(() => pending.delete(id)))
    );
  });
  const settle = Effect.fnUntraced(function* (
    id: string,
    result: { ok: true; data: unknown } | { ok: false; error: InvocationFailure }
  ) {
    const entry = pending.get(id);
    if (entry)
      yield* result.ok
        ? Deferred.succeed(entry.reply, result.data)
        : Deferred.fail(entry.reply, result.error);
  });
  const close = Effect.fnUntraced(function* () {
    closed = true;
    for (const { kind, reply } of pending.values())
      yield* Deferred.fail(reply, {
        code: lostInvocationCode(kind, 'exit'),
        message: 'Plugin process exited',
      });
  });
  return { invoke, settle, close };
}

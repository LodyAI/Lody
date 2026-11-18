import { Effect, Exit, Semaphore } from 'effect';
import {
  nativeSessionBodyFreezeRequestSchema,
  nativeSessionBodyFreezeReceiptSchema,
  type NativeSessionBodyFreezeRequest,
  type NativeSessionBodyFreezeReceipt,
  type NativeSessionBodyFreezeResponse,
} from '@lody/shared/native-session-body-control';
import type { SessionId } from '@lody/shared';
import type { ISession } from './session-manager';
import type { SessionExecutionSnapshot } from './session-execution-service';

type Work = { promise: Promise<unknown>; state: 'pending' | 'done' | 'failed'; error?: unknown };
type Held = {
  request: NativeSessionBodyFreezeRequest;
  generation: string;
  release(): void;
  released: boolean;
  prepared: boolean;
  retiredOnce: boolean;
  original?: ISession;
  work: Map<string, Work>;
  gate: Semaphore.Semaphore;
};
/** One local execution barrier, spanning prepare through native publish or
 * verified legacy abort. SDK/ACP Promise calls remain their original owners;
 * timing out a request never forgets their raw completion or cleanup handle. */
export class SessionNativeBodyMigrationControlLegacy {
  private closed = false;
  private readonly held = new Map<string, Held>();
  private readonly completed = new Map<string, 'publish' | 'abort'>();
  private closing: Promise<void> | undefined;
  constructor(
    private readonly ports: {
      accountId: string;
      workspaceId: string;
      generation(): string;
      unavailable(): boolean;
      tryBarrier(sessionId: SessionId): (() => void) | null;
      snapshot(sessionId: SessionId): SessionExecutionSnapshot;
      pending(sessionId: SessionId): Promise<ISession> | null;
      cached(sessionId: SessionId): ISession | null;
      retire(session: ISession): Promise<void>;
      flush(sessionId: SessionId): Promise<void>;
      freeze(
        sessionId: SessionId,
        nonce: string,
        phase: 'freeze' | 'assert'
      ): Promise<NativeSessionBodyFreezeReceipt>;
      route(sessionId: SessionId): 'legacy' | 'frozen' | 'native';
      waitMs?: number;
    }
  ) {}
  private key(request: NativeSessionBodyFreezeRequest) {
    return JSON.stringify([request.sessionId, request.nonce]);
  }
  private check(entry: Held) {
    if (
      this.closed ||
      this.ports.unavailable() ||
      entry.released ||
      this.held.get(entry.request.sessionId) !== entry ||
      entry.generation !== this.ports.generation()
    )
      throw new Error('Session migration generation changed');
  }
  private busy(sessionId: SessionId) {
    const state = this.ports.snapshot(sessionId);
    return (
      state.hasActiveTurn ||
      state.hasBlockingPendingCreate ||
      !!state.releaseBlocked ||
      !!this.ports.pending(sessionId)
    );
  }
  private io(entry: Held, key: string, operation: () => Promise<unknown>) {
    return Effect.suspend(() => {
      let work = entry.work.get(key);
      if (!work || work.state === 'failed') {
        const next: Work = { promise: Promise.resolve(), state: 'pending' };
        // This is the genuine legacy I/O boundary. Its completion remains in
        // the held entry after an Effect waiter times out or is interrupted.
        try {
          next.promise = Promise.resolve(operation());
        } catch (error) {
          next.promise = Promise.reject(error);
        }
        next.promise = next.promise.then(
          (value) => {
            next.state = 'done';
            return value;
          },
          (error) => {
            next.state = 'failed';
            next.error = error;
            throw error;
          }
        );
        void next.promise.catch(() => {});
        entry.work.set(key, next);
        work = next;
      }
      const retained = work;
      return Effect.tryPromise({ try: () => retained.promise, catch: (error) => error }).pipe(
        Effect.timeout(`${this.ports.waitMs ?? 5000} millis`)
      );
    });
  }
  private prepare(entry: Held) {
    return Effect.gen({ self: this }, function* () {
      this.check(entry);
      if (entry.prepared) return;
      const sessionId = entry.request.sessionId as SessionId;
      if (entry.original) {
        yield* this.io(entry, 'retire', () => {
          const original = entry.original;
          if (!original) return Promise.resolve();
          const alreadyRetired = entry.retiredOnce;
          entry.retiredOnce = true;
          const retired = alreadyRetired ? original.terminate(true) : this.ports.retire(original);
          return retired.then(() => {
            entry.original = undefined;
          });
        });
      }
      this.check(entry);
      yield* this.io(entry, 'flush', () => this.ports.flush(sessionId));
      this.check(entry);
      if (this.busy(sessionId) || this.ports.cached(sessionId))
        throw new Error('Session acquired new execution during migration preparation');
      entry.prepared = true;
    });
  }
  private release(entry: Held, phase: 'publish' | 'abort') {
    return Effect.gen({ self: this }, function* () {
      this.check(entry);
      if (entry.original || !entry.prepared) yield* this.prepare(entry);
      if (
        this.busy(entry.request.sessionId as SessionId) ||
        this.ports.cached(entry.request.sessionId as SessionId)
      )
        throw new Error('Session execution remains held');
      const route = this.ports.route(entry.request.sessionId as SessionId);
      if (route !== (phase === 'publish' ? 'native' : 'legacy'))
        throw new Error('Session migration release route mismatch');
      entry.release();
      entry.released = true;
      this.held.delete(entry.request.sessionId);
      this.completed.set(this.key(entry.request), phase);
      if (this.completed.size > 256) {
        const oldest = this.completed.keys().next().value;
        if (oldest !== undefined) this.completed.delete(oldest);
      }
    });
  }
  handle(input: NativeSessionBodyFreezeRequest): Promise<NativeSessionBodyFreezeResponse> {
    const parsed = nativeSessionBodyFreezeRequestSchema.safeParse(input);
    if (!parsed.success) return Promise.resolve({ ok: false, error: 'invalid_request' });
    const request = parsed.data;
    if (
      this.closed ||
      this.ports.unavailable() ||
      request.accountId !== this.ports.accountId ||
      request.workspaceId !== this.ports.workspaceId
    )
      return Promise.resolve({ ok: false, error: 'scope_unavailable' });
    let entry = this.held.get(request.sessionId);
    if (entry && entry.request.nonce !== request.nonce)
      return Promise.resolve({ ok: false, error: 'scope_unavailable' });
    if (!entry && this.completed.get(this.key(request)) === request.phase) {
      const expected = request.phase === 'publish' ? 'native' : 'legacy';
      try {
        if (this.ports.route(request.sessionId as SessionId) !== expected)
          throw new Error('Owner changed');
        return Promise.resolve({
          ...request,
          ok: true,
          phase: request.phase as 'publish' | 'abort',
          ownerGeneration: this.ports.generation(),
          released: true,
        });
      } catch {
        return Promise.resolve({ ok: false, error: 'scope_unavailable' });
      }
    }
    if (!entry) {
      if (
        request.phase !== 'prepare' ||
        this.completed.has(this.key(request)) ||
        this.held.size >= 128
      )
        return Promise.resolve({ ok: false, error: 'scope_unavailable' });
      // Synchronous claim/check before the first await, including child and
      // rewrite-conflict admission covered by the execution service barrier.
      const release = this.ports.tryBarrier(request.sessionId as SessionId);
      if (!release) return Promise.resolve({ ok: false, error: 'scope_unavailable' });
      try {
        if (
          this.busy(request.sessionId as SessionId) ||
          this.ports.route(request.sessionId as SessionId) === 'native'
        ) {
          release();
          return Promise.resolve({ ok: false, error: 'scope_unavailable' });
        }
        entry = {
          request,
          generation: this.ports.generation(),
          release,
          released: false,
          prepared: false,
          retiredOnce: false,
          original: this.ports.cached(request.sessionId as SessionId) ?? undefined,
          work: new Map(),
          gate: Semaphore.makeUnsafe(1),
        };
        this.held.set(request.sessionId, entry);
      } catch {
        release();
        return Promise.resolve({ ok: false, error: 'scope_unavailable' });
      }
    }
    const owner = entry;
    const program = owner.gate.withPermit(
      Effect.gen({ self: this }, function* () {
        this.check(owner);
        if (request.phase === 'prepare') {
          yield* this.prepare(owner);
          return {
            ...request,
            ok: true as const,
            phase: 'prepare' as const,
            ownerGeneration: owner.generation,
            prepared: true as const,
          };
        }
        if (request.phase === 'publish' || request.phase === 'abort') {
          yield* this.release(owner, request.phase);
          return {
            ...request,
            ok: true as const,
            phase: request.phase,
            ownerGeneration: owner.generation,
            released: true as const,
          };
        }
        if (
          !owner.prepared ||
          owner.original ||
          this.busy(request.sessionId as SessionId) ||
          this.ports.cached(request.sessionId as SessionId)
        )
          throw new Error('Session migration preparation is unconfirmed');
        if (owner.work.get(request.phase)?.state === 'done') owner.work.delete(request.phase);
        const receipt = yield* this.io(owner, request.phase, () =>
          this.ports.freeze(
            request.sessionId as SessionId,
            request.nonce,
            request.phase as 'freeze' | 'assert'
          )
        );
        this.check(owner);
        const validated = nativeSessionBodyFreezeReceiptSchema.parse(receipt);
        if (
          validated.ownerGeneration !== owner.generation ||
          validated.nonce !== request.nonce ||
          validated.sessionId !== request.sessionId ||
          validated.accountId !== request.accountId ||
          validated.workspaceId !== request.workspaceId ||
          validated.phase !== request.phase
        )
          throw new Error('Session migration freeze receipt changed');
        return validated;
      })
    );
    return Effect.runPromiseExit(program).then((exit) =>
      Exit.isSuccess(exit) ? exit.value : { ok: false, error: 'freeze_unconfirmed' }
    );
  }
  stopAdmission() {
    this.closed = true;
  }
  close(): Promise<void> {
    this.closed = true;
    if (this.closing) return this.closing;
    const work = Effect.runPromise(
      Effect.forEach(
        [...this.held.values()],
        (entry) =>
          entry.gate.withPermit(
            Effect.gen({ self: this }, function* () {
              const failure = yield* Effect.exit(
                Effect.gen({ self: this }, function* () {
                  if (entry.original)
                    yield* this.io(entry, 'cleanup', () => {
                      const original = entry.original;
                      return original
                        ? original.terminate(true).then(() => {
                            entry.original = undefined;
                          })
                        : Promise.resolve();
                    });
                  for (const pending of entry.work.values())
                    if (pending.state === 'pending')
                      yield* Effect.tryPromise({
                        try: () => pending.promise,
                        catch: (error) => error,
                      }).pipe(Effect.timeout(`${this.ports.waitMs ?? 5000} millis`));
                })
              );
              const release = yield* Effect.exit(
                Effect.sync(() => {
                  if (!entry.released) {
                    entry.release();
                    entry.released = true;
                  }
                })
              );
              if (Exit.isSuccess(failure) && Exit.isSuccess(release))
                this.held.delete(entry.request.sessionId);
              return [failure, release];
            })
          ),
        { concurrency: 4 }
      )
    ).then((results) => {
      const errors = results
        .flat()
        .filter(Exit.isFailure)
        .map((result) => result.cause);
      if (errors.length)
        throw new AggregateError(errors, 'Native Session migration cleanup remains unconfirmed');
    });
    this.closing = work;
    void work
      .finally(() => {
        if (this.closing === work) this.closing = undefined;
      })
      .catch(() => {});
    return work;
  }
}

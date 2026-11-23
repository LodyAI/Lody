import { Bytes } from '@lody/e2ee-core';
import { verifyLedger, hasVerifiedCheckpoint } from '@lody/e2ee-core/protocol';
import { Result } from 'effect';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Cause, Context, Data, Deferred, Effect, Exit, Schema } from 'effect';
import { LabCallbackRunner } from './run';
import { LabKeyCommand, type LabProcessConfiguration } from './process-contract';
/** Native child creation port; tests substitute real IPC workers, not fake exits. */
export const LabProcessSpawn = Context.Reference<() => ChildProcess>('Lab/ProcessSpawn', {
  defaultValue: () => () =>
    spawn(
      process.execPath,
      ['--import', 'tsx', fileURLToPath(new URL('./process-worker.ts', import.meta.url))],
      {
        cwd: fileURLToPath(new URL('../../', import.meta.url)),
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: { PATH: process.env.PATH, NODE_NO_WARNINGS: '1' },
      }
    ),
});
export class LabProcessError extends Data.TaggedError('LabProcessError')<{
  readonly code: 'closed' | 'not-started' | 'already-started' | 'native' | 'reply' | 'child-exited';
  readonly pid?: number;
}> {}
export interface LabProcessReply {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly trace?: {
    readonly frames: number;
    readonly cipherChanged: number;
    readonly ackDropped: number;
  };
  readonly localPoint?: { readonly head: string; readonly length: number };
  readonly error?: { readonly code: string; readonly tag: string };
}
interface Lease {
  readonly child: ChildProcess;
  readonly closed: Deferred.Deferred<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly pending: Map<number, Deferred.Deferred<LabProcessReply, LabProcessError>>;
  readonly stderr: () => string;
  done: boolean;
}
/** Thin native IPC bridge. Session operations execute as Effects in the child.
 * A crash is actual SIGKILL + actual close, not Scope.close or a simulated flag.
 * Restart receives a separately supplied trusted checkpoint and original fixture.
 * This is synthetic Lab process ownership, not production device/pin custody. */
export const makeLabProcessActor = Effect.fnUntraced(function* (
  configuration: (mode: 'create' | 'open') => Effect.Effect<LabProcessConfiguration, unknown>
) {
  const config = configuration;
  const spawnChild = yield* LabProcessSpawn;
  const callbacks = yield* Effect.acquireRelease(
    Effect.sync(() => new LabCallbackRunner()),
    (owner) => Effect.promise(() => owner.close())
  );
  let current: Lease | undefined,
    closed = false,
    sequence = 0;
  let localPoint: LabProcessConfiguration['point'] | undefined;
  const stop = (lease: Lease) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        if (!lease.done) lease.child.kill('SIGKILL');
        // SIGKILL requests termination; only the native close event releases this
        // owner. Machine load is not evidence that the child failed to settle.
        const result = yield* Deferred.await(lease.closed);
        if (current === lease) current = undefined;
        return result;
      })
    );
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      closed = true;
      if (current) yield* stop(current).pipe(Effect.orDie);
    })
  );
  const call = (command: Record<string, unknown>) =>
    Effect.acquireUseRelease(
      Effect.try({
        try: () => {
          const lease = current;
          if (closed) throw new LabProcessError({ code: 'closed' });
          if (!lease || lease.done) throw new LabProcessError({ code: 'not-started' });
          if (lease.pending.size >= 100) throw new LabProcessError({ code: 'reply' });
          const id = ++sequence;
          const wire = JSON.parse(
            JSON.stringify({ id, ...command, logicalTime: id * 4096 })
          ) as object;
          if (JSON.stringify(wire).length > 256 * 1024)
            throw new LabProcessError({ code: 'reply' });
          const ready = Deferred.makeUnsafe<LabProcessReply, LabProcessError>();
          lease.pending.set(id, ready);
          lease.child.send(wire, (error) => {
            if (error)
              Deferred.doneUnsafe(ready, Effect.fail(new LabProcessError({ code: 'native' })));
          });
          return { lease, id, ready };
        },
        catch: (cause) =>
          cause instanceof LabProcessError ? cause : new LabProcessError({ code: 'native' }),
      }),
      ({ ready }) =>
        Effect.gen(function* () {
          const reply = yield* Deferred.await(ready);
          if (reply.localPoint) {
            // Private IPC observations alone are not trusted pins: reverify the entire
            // independently witnessed original prefix against the parent's endpoint.
            const trusted = yield* config('open');
            const checked = yield* Effect.fromResult(
              verifyLedger({
                anchor: Result.getOrThrow(
                  Bytes.genesisHash(new Uint8Array(Buffer.from(trusted.genesis, 'hex')))
                ),
                records: trusted.records.map(
                  (record) => new Uint8Array(Buffer.from(record, 'hex'))
                ),
                checkpoint: {
                  head: Result.getOrThrow(
                    Bytes.recordHash(new Uint8Array(Buffer.from(trusted.point.head, 'hex')))
                  ),
                  length: trusted.point.length,
                },
              })
            );
            if (!/^[0-9a-f]{64}$/.test(reply.localPoint.head))
              return yield* new LabProcessError({ code: 'reply' });
            const observed = {
              head: Result.getOrThrow(
                Bytes.recordHash(new Uint8Array(Buffer.from(reply.localPoint.head, 'hex')))
              ),
              length: reply.localPoint.length,
            };
            if (!(yield* Effect.fromResult(hasVerifiedCheckpoint(checked, observed))))
              return yield* new LabProcessError({ code: 'reply' });
            localPoint = { ...reply.localPoint };
          }
          return reply;
        }),
      ({ lease, id }, exit) =>
        Effect.gen(function* () {
          lease.pending.delete(id);
          if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)) yield* stop(lease);
        })
    );
  const start = (mode: 'create' | 'open', materialIndex?: number) =>
    Effect.gen(function* () {
      if (closed) return yield* new LabProcessError({ code: 'closed' });
      if (current && !current.done) return yield* new LabProcessError({ code: 'already-started' });
      const owned = yield* config(mode);
      if (current && !current.done) return yield* new LabProcessError({ code: 'already-started' });
      if (closed) return yield* new LabProcessError({ code: 'closed' });
      yield* Effect.try({
        try: () => {
          const child = spawnChild();
          const exited = Deferred.makeUnsafe<{
            code: number | null;
            signal: NodeJS.Signals | null;
          }>();
          let stderr = '';
          const lease: Lease = {
            child,
            closed: exited,
            pending: new Map(),
            done: false,
            stderr: () => stderr,
          };
          child.stderr?.on('data', (bytes: Buffer) => {
            stderr = (stderr + bytes.toString()).slice(-64 * 1024);
          });
          child.on('message', (message: unknown) => {
            if (
              message &&
              typeof message === 'object' &&
              'kind' in message &&
              message.kind === 'checkpoint-request' &&
              'requestId' in message &&
              typeof message.requestId === 'number'
            ) {
              const requestId = message.requestId;
              void callbacks.run(config('open')).then(
                (trusted) => {
                  if (child.connected)
                    child.send({
                      kind: 'checkpoint-result',
                      requestId,
                      point: trusted.point,
                      records: trusted.records,
                    });
                },
                () => {
                  if (child.connected)
                    child.send({ kind: 'checkpoint-result', requestId, error: true });
                }
              );
              return;
            }
            if (
              !message ||
              typeof message !== 'object' ||
              !('id' in message) ||
              typeof message.id !== 'number'
            )
              return;
            const ready = lease.pending.get(message.id);
            if (!ready) return;
            if (
              JSON.stringify(message).length > 256 * 1024 ||
              !('ok' in message) ||
              typeof message.ok !== 'boolean'
            )
              Deferred.doneUnsafe(ready, Effect.fail(new LabProcessError({ code: 'reply' })));
            else Deferred.doneUnsafe(ready, Effect.succeed(message as LabProcessReply));
          });
          child.once('error', () => {
            for (const ready of lease.pending.values())
              Deferred.doneUnsafe(ready, Effect.fail(new LabProcessError({ code: 'native' })));
          });
          child.once('close', (code, signal) => {
            lease.done = true;
            for (const ready of lease.pending.values())
              Deferred.doneUnsafe(
                ready,
                Effect.fail(new LabProcessError({ code: 'child-exited' }))
              );
            Deferred.doneUnsafe(exited, Effect.succeed({ code, signal }));
          });
          current = lease;
        },
        catch: () => new LabProcessError({ code: 'native' }),
      });
      const selected = { ...owned, localPoint: owned.localPoint ?? localPoint };
      const result = yield* call({
        operation: 'open',
        configuration: selected,
        materialIndex,
      }).pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit) && current ? stop(current).pipe(Effect.asVoid) : Effect.void
        )
      );
      if (
        !result.ok &&
        result.error?.code === 'wrong-parent' &&
        selected.localPoint &&
        (selected.localPoint.head !== owned.point.head ||
          selected.localPoint.length !== owned.point.length)
      )
        // Exactly two external known pins, never SQL-selected metadata. Both attempts
        // reverify local originals; fresh network refresh precedes any key/content use.
        return yield* call({
          operation: 'open',
          configuration: { ...owned, localPoint: owned.point },
        });
      return result;
    });
  return Object.freeze({
    start,
    keyCommand: (command: LabKeyCommand, materialIndex?: number) =>
      Effect.gen(function* () {
        const owned = yield* Effect.fromResult(Schema.decodeUnknownResult(LabKeyCommand)(command));
        const trusted = yield* config('open');
        return yield* call({ ...owned, point: trusted.point, materialIndex });
      }),
    call: (
      operation:
        | 'keys'
        | 'refresh'
        | 'resume'
        | 'create'
        | 'append'
        | 'upload-snapshot'
        | 'edit-offline'
        | 'flush-offline'
        | 'pull'
        | 'recover'
        | 'observe'
        | 'persist'
        | 'attack'
        | 'acknowledge'
        | 'revoke'
        | 'set-role'
        | 'rotate-epoch'
        | 'remove-member-and-rotate'
        | 'resume-epoch-rotation'
        | 'acknowledge-epoch-rotation'
        | 'publish-without-stage',
      document?: string,
      text?: string,
      options?: {
        readonly target?: string;
        readonly role?: 'admin' | 'member' | 'guest';
        readonly materialIndex?: number;
      }
    ) =>
      Effect.gen(function* () {
        const trusted = yield* config('open');
        return yield* call({
          operation,
          document,
          text,
          ...options,
          point: trusted.point,
          records: trusted.records,
        });
      }),
    crash: () =>
      Effect.suspend(() =>
        current ? stop(current) : Effect.fail(new LabProcessError({ code: 'not-started' }))
      ),
    shutdown: () =>
      Effect.gen(function* () {
        if (!current) return;
        const lease = current;
        yield* call({ operation: 'close' });
        // The enclosing scenario/test watchdog owns a stuck harness. Graceful
        // completion itself is observed from native close, never a short deadline.
        yield* Deferred.await(lease.closed);
        if (current === lease) current = undefined;
      }),
    pid: () => current?.child.pid,
    diagnostics: () => current?.stderr() ?? '',
  });
});

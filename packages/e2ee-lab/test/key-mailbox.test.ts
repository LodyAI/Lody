import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Exit, Fiber, Result, Scope } from 'effect';
import { describe, expect, it } from 'vitest';
import { makeSqliteKeyMailbox } from '@lody/e2ee-core/adapters/node-sqlite';
import { makeLabMailboxRemote } from '../src/platform/key-mailbox';
import { history } from './ledger-fixture';
import { makeSyntheticMailboxHttp } from './mailbox-http-fixture';
const ok = Result.getOrThrow;
const latch = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
describe('Lab HTTP mailbox transport consuming public SQLite mailbox', () => {
  it('round trips real current targets, empty recipient pages and protected server failures across reopen', async () => {
    const f = history(),
      dir = mkdtempSync(join(tmpdir(), 'lab-http-mailbox-'));
    try {
      for (const mode of ['create', 'open'] as const) {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const host = yield* makeSqliteKeyMailbox({
                path: join(dir, 'mailbox.sqlite'),
                mode,
                genesis: f.anchor,
                ledger: () => Effect.succeed(f.view),
              });
              const remote = ok(host.bind(f.owner.publicKey));
              const url = yield* makeSyntheticMailboxHttp(remote);
              const client = yield* makeLabMailboxRemote({ url, fetch });
              const slot = {
                genesis: Buffer.from(f.anchor.toBytes()).toString('hex'),
                epoch: 1,
                recipient: Buffer.from(f.owner.publicKey.toBytes()).toString('hex'),
              };
              expect(yield* client.status(slot)).toEqual({
                ...slot,
                revision: 0,
                status: 'NeedsEnvelope',
              });
              expect(yield* client.list('needsEnvelope', null, 100)).toEqual({
                items: [{ ...slot, revision: 0, status: 'NeedsEnvelope' }],
                next: null,
              });
              expect(yield* client.fetch(1, null, 100)).toEqual({ items: [], next: null });
              expect(yield* client.read('01'.repeat(16))).toBeNull();
              const wrongEpoch = yield* Effect.result(client.fetch(2, null, 100));
              expect(Result.isFailure(wrongEpoch)).toBe(true);
              if (Result.isFailure(wrongEpoch))
                expect(wrongEpoch.failure.code).toBe('unauthorized');
              expect(
                Result.isFailure(
                  yield* Effect.result(client.put('01'.repeat(16), new Uint8Array([1])))
                )
              ).toBe(true);
              expect(yield* client.fetch(1, null, 100)).toEqual({ items: [], next: null });
            })
          )
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('refuses malformed hex, unsafe revisions/epochs, oversized pages/bodies and invalid acknowledgements', async () => {
    const f = history();
    const slot = {
      genesis: Buffer.from(f.anchor.toBytes()).toString('hex'),
      epoch: 1,
      recipient: Buffer.from(f.owner.publicKey.toBytes()).toString('hex'),
    };
    const responses = [
      'gg',
      'a',
      { ...slot, revision: 0.5, status: 'NeedsEnvelope' },
      { ...slot, epoch: Number.MAX_SAFE_INTEGER + 1, revision: 0, status: 'NeedsEnvelope' },
      { items: Array(101).fill({ sender: '00'.repeat(32), frame: '01' }), next: null },
      { items: [], next: 'not-a-cursor' },
      { ok: false },
      'x'.repeat(128 * 1024),
      new Response('not json'),
      new Response(new Uint8Array([255])),
    ];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* makeLabMailboxRemote({
            url: 'http://synthetic.invalid/mailbox',
            fetch: async () => {
              const response = responses.shift();
              return response instanceof Response
                ? response
                : new Response(JSON.stringify(response));
            },
          });
          const operations = [
            client.read('01'.repeat(16)),
            client.read('01'.repeat(16)),
            client.status(slot),
            client.status(slot),
            client.fetch(1, null, 100),
            client.fetch(1, null, 100),
            client.put('01'.repeat(16), new Uint8Array([1])),
            client.read('01'.repeat(16)),
            client.read('01'.repeat(16)),
            client.read('01'.repeat(16)),
          ];
          for (const operation of operations) {
            const result = yield* Effect.result(operation);
            expect(Result.isFailure(result)).toBe(true);
            if (Result.isFailure(result)) expect(result.failure.code).toBe('invalid-response');
          }
        })
      )
    );
  });
  it('waits for the actual abort-ignoring response body before closing earlier owners and refuses late output', async () => {
    const entered = latch(),
      aborted = latch(),
      release = latch();
    let transportClosedEarly = false,
      transportClosed = false;
    let bodySettled = false,
      closedEarly = false,
      ownerClosed = false;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const child = yield* Scope.make();
          yield* Scope.addFinalizer(
            child,
            Effect.sync(() => {
              closedEarly = !bodySettled;
              ownerClosed = true;
            })
          );
          const client = yield* makeLabMailboxRemote({
            url: 'http://synthetic.invalid/mailbox',
            close: async () => {
              transportClosedEarly = !bodySettled;
              transportClosed = true;
            },
            fetch: async (_input, init) => {
              init!.signal!.addEventListener('abort', aborted.resolve, { once: true });
              return new Response(
                new ReadableStream<Uint8Array>({
                  async pull(controller) {
                    entered.resolve();
                    await release.promise;
                    bodySettled = true;
                    controller.enqueue(new TextEncoder().encode('null'));
                    controller.close();
                  },
                })
              );
            },
          }).pipe(Effect.provideService(Scope.Scope, child));
          const worker = yield* Effect.forkChild(Effect.result(client.read('01'.repeat(16))));
          // Gate finalizer executes before worker cleanup on an assertion failure.
          yield* Effect.addFinalizer(() => Effect.sync(release.resolve));
          yield* Effect.promise(() => entered.promise);
          const closing = yield* Effect.forkChild(Scope.close(child, Exit.void));
          yield* Effect.promise(() => aborted.promise);
          const pending = closing.pollUnsafe();
          release.resolve();
          yield* Fiber.join(closing);
          expect(pending).toBeUndefined();
          expect(bodySettled).toBe(true);
          expect(transportClosed).toBe(true);
          expect(transportClosedEarly).toBe(false);
          expect(ownerClosed).toBe(true);
          expect(closedEarly).toBe(false);
          expect(Result.isFailure(yield* Fiber.join(worker))).toBe(true);
          const late = yield* Effect.result(client.read('01'.repeat(16)));
          expect(Result.isFailure(late)).toBe(true);
          if (Result.isFailure(late)) expect(late.failure.code).toBe('closed');
        })
      )
    );
  });
});

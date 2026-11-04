import { execNativeChild } from '../native-child';
import { createServer, type ServerResponse, type IncomingMessage } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { Effect, Result, Deferred, Fiber, Scope, Exit } from 'effect';
import { describe, expect, it } from 'vitest';
import { StreamsClient } from '@loro-dev/streams-client';
import {
  makeStreamsLedgerLog,
  makeLedgerStreamReader,
} from '@lody/e2ee-core/adapters/loro-streams';
import { LedgerLog } from '@lody/e2ee-core/services';
import { submitRecord, resumeSubmission } from './fixture';
import { sqliteSubmissionJournal } from '@lody/e2ee-core/adapters/node-sqlite';
import { frameLedgerRecord } from '@lody/e2ee-core/protocol';
import { extendLedger, hashRecordBytes, requireLedgerContinuation } from '@lody/e2ee-core/protocol';
import { anchor, checkpoint, genesis, host, rotate, filled, owner, signed } from './fixture';
import { Bytes } from '@lody/e2ee-core/protocol';
const ok = Result.getOrThrow;
async function localHost() {
  const dir = mkdtempSync(path.join(tmpdir(), 'submission-sdk-')),
    store = host(path.join(dir, 'host.sqlite'));
  let mode:
    | 'normal'
    | 'lost-ack'
    | 'unsupported'
    | 'conflict'
    | 'corrupt'
    | 'cycle'
    | 'empty-jump' = 'normal';
  let arrived!: () => void, release!: () => void;
  const received = new Promise<void>((resolve) => {
      arrived = resolve;
    }),
    released = new Promise<void>((resolve) => {
      release = resolve;
    });
  let held = false;
  const requests: { expected: string | null; body: Uint8Array }[] = [];
  const send = (res: ServerResponse, status: number, offset: string, body?: Uint8Array) => {
    res.writeHead(status, {
      'Content-Type': 'application/octet-stream',
      'Stream-Next-Offset': offset,
      'Stream-Up-To-Date': 'true',
    });
    res.end(body);
  };
  const tail = () => `tail/${store.read().length}`;
  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) =>
      res.destroy(error instanceof Error ? error : new Error('synthetic host failed'))
    );
  });
  async function handle(req: IncomingMessage, res: ServerResponse) {
    try {
      if (req.method === 'GET') {
        if (mode === 'empty-jump') {
          send(res, 200, 'empty/forged', new Uint8Array());
          return;
        }
        if (mode === 'cycle') {
          const frame = ok(frameLedgerRecord(genesis));
          const offset = new URL(req.url!, 'http://local.test').searchParams.get('offset');
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Stream-Next-Offset':
              offset === '-1' ? 'partial/a' : offset === 'partial/a' ? 'partial/b' : 'partial/a',
            'Stream-Up-To-Date': offset === 'partial/b' ? 'true' : 'false',
          });
          res.end(
            offset === '-1'
              ? frame.slice(0, 7)
              : offset === 'partial/a'
                ? frame.slice(7, 13)
                : frame.slice(13)
          );
          return;
        }
        const records = mode === 'corrupt' ? [new Uint8Array(genesis.length)] : store.read();
        send(
          res,
          200,
          tail(),
          new Uint8Array(
            Buffer.concat(records.map((record) => Buffer.from(ok(frameLedgerRecord(record)))))
          )
        );
        return;
      }
      if (req.method === 'POST' && req.url === '/ledger/append-cas') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = new Uint8Array(Buffer.concat(chunks)),
          expected =
            typeof req.headers['stream-expected-offset'] === 'string'
              ? req.headers['stream-expected-offset']
              : null;
        requests.push({ expected, body });
        if (mode === 'unsupported') {
          send(res, 501, tail());
          return;
        }
        if (mode === 'conflict') {
          store.append(rotate(undefined, 22));
          mode = 'normal';
        }
        if (expected !== tail()) {
          res.setHeader('Stream-Expected-Offset', expected ?? 'missing');
          send(res, 409, tail());
          return;
        }
        const length = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(
          0,
          false
        );
        if (length !== body.length - 4) {
          send(res, 400, tail());
          return;
        }
        store.append(body.slice(4));
        arrived();
        if (mode === 'lost-ack') {
          req.socket.destroy();
          return;
        }
        if (held) await released;
        send(res, 204, tail());
        return;
      }
      send(res, 404, tail());
    } catch {
      send(res, 500, tail());
    }
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as { port: number }).port;
  const sdk = new StreamsClient({
    url: `http://127.0.0.1:${port}/ledger`,
    retry: { maxAttempts: 1 },
  });
  return {
    dir,
    store,
    sdk,
    url: `http://127.0.0.1:${port}/ledger`,
    requests,
    received,
    release,
    hold: () => {
      held = true;
    },
    mode: (value: typeof mode) => {
      mode = value;
    },
    make: () =>
      makeStreamsLedgerLog({
        genesis: anchor,
        stream: sdk,
        checkpoint: () => Effect.sync(() => checkpoint(store.read())),
        budget: { maxRecords: 100, maxBytes: 100000 },
      }),
    close: async () => {
      release();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
      store.db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const using = <A, E, R>(f: Awaited<ReturnType<typeof localHost>>, effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const remote = yield* f.make();
      return yield* effect.pipe(
        Effect.provideService(LedgerLog, remote),
        Effect.provide(sqliteSubmissionJournal({ path: path.join(f.dir, 'journal.sqlite') }))
      );
    })
  );
describe('released SDK CAS bound to independently verified ledger endpoint', () => {
  it('shares a genuine same-read view without lending its authority or replacing the verified CAS mapping on a bad read', async () => {
    const f = await localHost();
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const remote = yield* f.make();
            const history = yield* remote.read(anchor);
            expect(history.records).toEqual([genesis]);
            expect(history.checkpoint).toEqual(checkpoint([genesis]));
            expect(history.view.genesis.equals(anchor)).toBe(true);
            expect(history.view.head.equals(history.checkpoint.head)).toBe(true);
            expect(history.view.length).toBe(history.checkpoint.length);
            const next = ok(
              extendLedger(history.view, [rotate()], checkpoint([genesis, rotate()]))
            );
            expect(next.length).toBe(2);
            expect(Result.isSuccess(requireLedgerContinuation(history.view, next))).toBe(true);
            history.records[0]!.fill(0);
            f.mode('corrupt');
            expect(Result.isFailure(yield* Effect.result(remote.read(anchor)))).toBe(true);
            expect(history.view.head.equals(checkpoint([genesis]).head)).toBe(true);
            expect(
              Result.isFailure(
                yield* Effect.result(
                  remote.appendCas(anchor, checkpoint([genesis, rotate()]), rotate())
                )
              )
            ).toBe(true);
            f.mode('normal');
            yield* remote.appendCas(anchor, history.checkpoint, rotate());
          })
        )
      );
      expect(f.store.read()).toEqual([genesis, rotate()]);
      expect(f.requests).toEqual([{ expected: 'tail/1', body: ok(frameLedgerRecord(rotate())) }]);
    } finally {
      await f.close();
    }
  });
  it('rejects later rollback and forks in verified reads and retains the original view-offset pair for CAS', async () => {
    const f = await localHost(),
      record = rotate(),
      fork = rotate(undefined, 22),
      successor = signed([
        hashRecordBytes(record).toBytes(),
        owner.pk,
        [7, 2, filled(23), filled(31, 72)],
      ]);
    try {
      f.store.append(record);
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const remote = yield* f.make();
            const history = yield* remote.read(anchor);
            f.store.db.prepare('DELETE FROM records WHERE position = 1').run();
            expect(Result.isFailure(yield* Effect.result(remote.read(anchor)))).toBe(true);
            f.store.db.prepare('INSERT INTO records VALUES(1, ?)').run(fork);
            expect(Result.isFailure(yield* Effect.result(remote.read(anchor)))).toBe(true);
            expect(
              Result.isFailure(
                yield* Effect.result(
                  remote.appendCas(anchor, checkpoint([genesis, fork]), successor)
                )
              )
            ).toBe(true);
            f.store.db.prepare('UPDATE records SET record = ? WHERE position = 1').run(record);
            yield* remote.appendCas(anchor, history.checkpoint, successor);
            const after = yield* remote.read(anchor);
            expect(after.records).toEqual([genesis, record, successor]);
            expect(Result.isSuccess(requireLedgerContinuation(history.view, after.view))).toBe(
              true
            );
          })
        )
      );
      expect(f.store.read()).toEqual([genesis, record, successor]);
      expect(f.requests).toEqual([{ expected: 'tail/2', body: ok(frameLedgerRecord(successor)) }]);
    } finally {
      await f.close();
    }
  });
  it.each(['normal', 'lost-ack'] as const)(
    'persists exact P09 original and reads back through actual HTTP/SQLite (%s)',
    async (mode) => {
      const f = await localHost(),
        record = rotate();
      try {
        f.mode(mode);
        expect(await Effect.runPromise(using(f, submitRecord(anchor, record)))).toEqual({
          outcome: 'Committed',
          record,
        });
        expect(f.store.read()).toEqual([genesis, record]);
        expect(f.requests).toEqual([{ expected: 'tail/1', body: ok(frameLedgerRecord(record)) }]);
        expect(await Effect.runPromise(using(f, resumeSubmission(anchor)))).toEqual({
          outcome: 'Committed',
          record,
        });
        const child = JSON.parse(
          await execNativeChild(
            process.execPath,
            [
              '--import',
              'tsx',
              new URL('./streams-reopen.mts', import.meta.url).pathname,
              JSON.stringify({
                url: f.url,
                path: path.join(f.dir, 'journal.sqlite'),
                genesis: Buffer.from(anchor.toBytes()).toString('hex'),
                head: Buffer.from(checkpoint(f.store.read()).head.toBytes()).toString('hex'),
                count: 2,
              }),
            ],
            { cwd: process.cwd() }
          )
        );
        expect(child.pid).not.toBe(process.pid);
        expect(child.outcome).toBe('Committed');
        expect(child.record).toBe(Buffer.from(record).toString('hex'));
        const db = new Database(path.join(f.dir, 'journal.sqlite'));
        try {
          const row = db
            .prepare('SELECT pending,result_record,outcome FROM submission_journal')
            .get() as { pending: null; result_record: Uint8Array; outcome: string };
          expect(row.pending).toBeNull();
          expect(new Uint8Array(row.result_record)).toEqual(record);
          expect(row.outcome).toBe('Committed');
        } finally {
          db.close();
        }
      } finally {
        await f.close();
      }
    }
  );
  it('keeps exact pending when CAS is unsupported and never falls back to ordinary append', async () => {
    const f = await localHost(),
      record = rotate();
    try {
      f.mode('unsupported');
      expect(
        Result.isFailure(
          await Effect.runPromise(Effect.result(using(f, submitRecord(anchor, record))))
        )
      ).toBe(true);
      expect(f.store.read()).toEqual([genesis]);
      const db = new Database(path.join(f.dir, 'journal.sqlite'));
      try {
        const row = db.prepare('SELECT pending,outcome FROM submission_journal').get() as {
          pending: Uint8Array;
          outcome: null;
        };
        expect(new Uint8Array(row.pending)).toEqual(record);
        expect(row.outcome).toBeNull();
      } finally {
        db.close();
      }
      f.mode('normal');
      expect(await Effect.runPromise(using(f, resumeSubmission(anchor)))).toEqual({
        outcome: 'Committed',
        record,
      });
      expect(f.requests.every((row) => row.expected === 'tail/1')).toBe(true);
    } finally {
      await f.close();
    }
  });
  it('a concurrent committed branch becomes P09 Conflict rather than rewriting or replaying the original', async () => {
    const f = await localHost(),
      record = rotate();
    try {
      f.mode('conflict');
      expect(await Effect.runPromise(using(f, submitRecord(anchor, record)))).toEqual({
        outcome: 'Conflict',
        record,
      });
      expect(f.store.read()).toEqual([genesis, rotate(undefined, 22)]);
    } finally {
      await f.close();
    }
  });
  it('rejects unverified endpoint mapping, wrong Org and unsigned records before CAS', async () => {
    const f = await localHost();
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const remote = yield* f.make();
            expect(
              Result.isFailure(
                yield* Effect.result(remote.appendCas(anchor, checkpoint([genesis]), rotate()))
              )
            ).toBe(true);
            expect(
              Result.isFailure(yield* Effect.result(remote.read(ok(Bytes.genesisHash(filled(90))))))
            ).toBe(true);
            yield* remote.read(anchor);
            const bad = rotate();
            bad[bad.length - 1] ^= 1;
            expect(
              Result.isFailure(
                yield* Effect.result(remote.appendCas(anchor, checkpoint([genesis]), bad))
              )
            ).toBe(true);
            f.mode('corrupt');
            expect(Result.isFailure(yield* Effect.result(remote.read(anchor)))).toBe(true);
            f.mode('normal');
            yield* remote.appendCas(anchor, checkpoint([genesis]), rotate());
          })
        )
      );
      expect(f.store.read()).toEqual([genesis, rotate()]);
      expect(f.requests).toEqual([{ expected: 'tail/1', body: ok(frameLedgerRecord(rotate())) }]);
    } finally {
      await f.close();
    }
  });
  it('rejects an actual SDK empty page position jump and preserves normal framing', async () => {
    const f = await localHost();
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const reader = yield* makeLedgerStreamReader(f.sdk);
            f.mode('empty-jump');
            expect(Result.isFailure(yield* Effect.result(reader.readAfter('-1')))).toBe(true);
            f.mode('normal');
            const page = yield* reader.readAfter('-1');
            expect(page.records).toEqual([genesis]);
            expect(page.nextOffset).toBe('tail/1');
            expect(page.upToDate).toBe(true);
          })
        )
      );
      expect(f.store.read()).toEqual([genesis]);
    } finally {
      await f.close();
    }
  });
  it('rejects a repeated partial-frame SDK offset even when the assembled signed history is valid', async () => {
    const f = await localHost();
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const remote = yield* f.make();
            f.mode('cycle');
            expect(Result.isFailure(yield* Effect.result(remote.read(anchor)))).toBe(true);
            expect(
              Result.isFailure(
                yield* Effect.result(remote.appendCas(anchor, checkpoint([genesis]), rotate()))
              )
            ).toBe(true);
            f.mode('normal');
            yield* remote.read(anchor);
            yield* remote.appendCas(anchor, checkpoint([genesis]), rotate());
          })
        )
      );
      expect(f.store.read()).toEqual([genesis, rotate()]);
      expect(f.requests).toEqual([{ expected: 'tail/1', body: ok(frameLedgerRecord(rotate())) }]);
    } finally {
      await f.close();
    }
  });
  it('retains initialization-time SDK methods and refuses history beyond the declared byte budget', async () => {
    const f = await localHost();
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const tooSmall = yield* makeStreamsLedgerLog({
              genesis: anchor,
              stream: f.sdk,
              checkpoint: () => Effect.succeed(checkpoint([genesis])),
              budget: { maxRecords: 100, maxBytes: genesis.length - 1 },
            });
            expect(Result.isFailure(yield* Effect.result(tooSmall.read(anchor)))).toBe(true);
            expect(
              Result.isFailure(
                yield* Effect.result(tooSmall.appendCas(anchor, checkpoint([genesis]), rotate()))
              )
            ).toBe(true);
            const remote = yield* f.make();
            f.sdk.read = async () => {
              throw new Error('replaced read');
            };
            f.sdk.appendCas = async () => {
              throw new Error('replaced CAS');
            };
            yield* remote.read(anchor);
            yield* remote.appendCas(anchor, checkpoint([genesis]), rotate());
          })
        )
      );
      expect(f.store.read()).toEqual([genesis, rotate()]);
      expect(f.requests).toEqual([{ expected: 'tail/1', body: ok(frameLedgerRecord(rotate())) }]);
    } finally {
      await f.close();
    }
  });
  it('Scope close awaits the actual non-abortable SDK CAS and rejects late completion', async () => {
    const f = await localHost();
    try {
      f.hold();
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const scope = yield* Scope.make(),
              closingEntered = yield* Deferred.make<void>();
            const remote = yield* f.make().pipe(Effect.provideService(Scope.Scope, scope));
            yield* Effect.addFinalizer(() => Deferred.succeed(closingEntered, undefined)).pipe(
              Effect.provideService(Scope.Scope, scope)
            );
            yield* remote.read(anchor);
            const writing = yield* Effect.forkChild(
              Effect.result(remote.appendCas(anchor, checkpoint([genesis]), rotate()))
            );
            yield* Effect.promise(() => f.received);
            const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void));
            yield* Deferred.await(closingEntered);
            expect(closing.pollUnsafe()).toBeUndefined();
            expect(writing.pollUnsafe()).toBeUndefined();
            f.release();
            yield* Fiber.join(closing);
            expect(Result.isFailure(yield* Fiber.join(writing))).toBe(true);
            expect(Result.isFailure(yield* Effect.result(remote.read(anchor)))).toBe(true);
          })
        )
      );
      expect(f.store.read()).toEqual([genesis, rotate()]);
    } finally {
      await f.close();
    }
  });
});

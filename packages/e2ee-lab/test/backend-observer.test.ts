import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Effect, Result } from 'effect';
import { startDevServer } from '@loro-dev/sqlite-riverrun';
import { StreamsClient } from '@loro-dev/streams-client';
import { Bytes } from '@lody/e2ee-core';
import { expect, it } from 'vitest';
import { observeLabBackendBytes } from '../src/platform/backend-observer';
const ok = Result.getOrThrow;
const bytes = (value: string) => new TextEncoder().encode(value);
const genesis = ok(Bytes.genesisHash(new Uint8Array(32).fill(72)));
const org = Buffer.from(genesis.toBytes()).toString('hex');
const refusal = (result: Result.Result<unknown, unknown>, code: string) => {
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result))
    expect(result.failure).toMatchObject({ _tag: 'LabBackendObservationError', code });
};
const nativeFixture = Effect.fnUntraced(function* (directory: string) {
  const server = yield* Effect.acquireRelease(
    Effect.uninterruptible(
      Effect.tryPromise({
        try: () =>
          startDevServer({
            host: '127.0.0.1',
            port: 0,
            protocol: 'http1',
            dbPath: join(directory, 'native.sqlite'),
          }),
        catch: (cause) => cause,
      })
    ),
    (value) => Effect.promise(() => value.close())
  );
  const send = (url: string, method: string, body?: Uint8Array) =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(url, {
          method,
          headers: { 'content-type': 'application/octet-stream' },
          body: body && new Uint8Array(body),
        });
        await response.body?.cancel();
        return response.status;
      },
      catch: (cause) => cause,
    });
  expect(yield* send(`${server.baseUrl}/ds/${org}`, 'PUT')).toBe(201);
  const offsets: Record<string, string> = {};
  for (const model of ['loro', 'flock'] as const) {
    const url = `${server.baseUrl}/ds/${org}/${model}`;
    const sdk = new StreamsClient({ url, retry: { maxAttempts: 1 } });
    expect(
      (yield* Effect.promise(() => sdk.create({ contentType: 'application/octet-stream' }))).ok
    ).toBe(true);
    const first = yield* Effect.promise(() =>
      sdk.append({
        part: { contentType: 'application/octet-stream', body: bytes(`entry-before-${model}`) },
      })
    );
    if (!first.ok) throw new Error('actual native append failed');
    offsets[model] = first.result.nextOffset;
    expect(
      yield* send(`${url}/snapshot/${offsets[model]}`, 'PUT', bytes(`snapshot-${model}`))
    ).toBe(204);
    expect(
      (yield* Effect.promise(() =>
        sdk.append({
          part: { contentType: 'application/octet-stream', body: bytes(`entry-after-${model}`) },
        })
      )).ok
    ).toBe(true);
    // Retention is set only by the real snapshot API, never by a test SQL rewrite.
    expect(yield* send(`${url}?offset=-1`, 'GET')).toBe(410);
  }
  // Neither another Org nor this Org's control stream is document observation input.
  const foreign = 'ad'.repeat(32);
  expect(yield* send(`${server.baseUrl}/ds/${foreign}`, 'PUT')).toBe(201);
  for (const [bucket, model] of [
    [org, 'control'],
    [foreign, 'loro'],
  ] as const) {
    const sdk = new StreamsClient({
      url: `${server.baseUrl}/ds/${bucket}/${model}`,
      retry: { maxAttempts: 1 },
    });
    expect(
      (yield* Effect.promise(() => sdk.create({ contentType: 'application/octet-stream' }))).ok
    ).toBe(true);
    expect(
      (yield* Effect.promise(() =>
        sdk.append({
          part: { contentType: 'application/octet-stream', body: bytes('excluded-storage-bait') },
        })
      )).ok
    ).toBe(true);
  }
  return { path: server.dbPath, offsets };
});

it('observes actual retained entries and snapshots despite ordinary 410, with exact Org/model scope and owned copies', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lab-backend-byte-observer-'));
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* nativeFixture(directory);
          const inventory = () => {
            const db = new Database(f.path, { readonly: true, fileMustExist: true });
            try {
              return {
                streams: db
                  .prepare(
                    'SELECT bucket_id,stream_id,next_offset,earliest_offset FROM streams ORDER BY id'
                  )
                  .all(),
                snapshots: db
                  .prepare(
                    'SELECT stream_id_fk,snapshot_offset,length(body) n FROM snapshots ORDER BY id'
                  )
                  .all(),
                entries: db
                  .prepare(
                    'SELECT stream_id_fk,start_offset,end_offset,length(body) n FROM entries ORDER BY id'
                  )
                  .all(),
              };
            } finally {
              db.close();
            }
          };
          const before = inventory();
          const observed = yield* observeLabBackendBytes({ path: f.path, genesis });
          expect(observed.source).toBe('sqlite-riverrun-0.3.0');
          expect(observed.genesis).toBe(org);
          expect(observed.metadata).toMatchObject({
            rows: 6,
            entries: 4,
            snapshots: 2,
            models: { loro: { entries: 2, snapshots: 1 }, flock: { entries: 2, snapshots: 1 } },
          });
          expect(observed.metadata.bytes).toBe(
            observed.rows.reduce((sum, row) => sum + row.body.length, 0)
          );
          for (const model of ['loro', 'flock'] as const) {
            expect(
              observed.rows
                .filter((row) => row.model === model)
                .map((row) => new TextDecoder().decode(row.body))
                .sort()
            ).toEqual(
              [`entry-before-${model}`, `entry-after-${model}`, `snapshot-${model}`].sort()
            );
            expect(
              observed.rows.find((row) => row.kind === 'snapshot' && row.model === model)
                ?.snapshotOffset
            ).toBe(f.offsets[model]);
            expect(
              observed.rows
                .filter((row) => row.kind === 'entry' && row.model === model)
                .some((row) => row.startOffset === '0'.repeat(20))
            ).toBe(true);
          }
          observed.rows[0]!.body.fill(0);
          const fresh = yield* observeLabBackendBytes({ path: f.path, genesis });
          expect(fresh.rows[0]!.body).not.toEqual(observed.rows[0]!.body);
          expect(new TextDecoder().decode(fresh.rows[0]!.body)).toMatch(/^entry-/);
          expect(inventory()).toEqual(before);
        })
      )
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('fails closed on row/byte budgets, malformed storage and missing databases without returning partial observations', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lab-backend-byte-budgets-'));
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* nativeFixture(directory);
          refusal(
            yield* Effect.result(
              observeLabBackendBytes({
                path: f.path,
                genesis,
                budget: { maxRows: 1, maxBytes: 16 * 1024 * 1024 },
              })
            ),
            'budget'
          );
          refusal(
            yield* Effect.result(
              observeLabBackendBytes({
                path: f.path,
                genesis,
                budget: { maxRows: 4096, maxBytes: 1 },
              })
            ),
            'budget'
          );
          refusal(
            yield* Effect.result(
              observeLabBackendBytes({
                path: f.path,
                genesis,
                budget: { maxRows: 4097, maxBytes: 16 * 1024 * 1024 },
              })
            ),
            'invalid-input'
          );
          const writer = new Database(f.path);
          try {
            const identity = writer
              .prepare(
                "SELECT e.id,s.id streamId FROM entries e JOIN streams s ON s.id=e.stream_id_fk WHERE s.bucket_id=? AND s.stream_id='loro' LIMIT 1"
              )
              .get(org) as { id: number; streamId: number };
            // SQLite creates the large blob; no JavaScript payload allocation is used.
            writer
              .prepare('UPDATE entries SET body=zeroblob(?) WHERE id=?')
              .run(16 * 1024 * 1024 + 1, identity.id);
            refusal(
              yield* Effect.result(observeLabBackendBytes({ path: f.path, genesis })),
              'budget'
            );
            writer
              .prepare('UPDATE entries SET body=? WHERE id=?')
              .run('invalid TEXT body', identity.id);
            refusal(
              yield* Effect.result(observeLabBackendBytes({ path: f.path, genesis })),
              'corrupt'
            );
            writer
              .prepare('UPDATE entries SET body=? WHERE id=?')
              .run(bytes('restored bounded bytes'), identity.id);
            writer
              .transaction(() => {
                const insert = writer.prepare(
                  "INSERT INTO entries(stream_id_fk,start_offset,end_offset,body,created_at) VALUES(?,0,0,x'',0)"
                );
                for (let index = 0; index < 4097; index++) insert.run(identity.streamId);
              })
              .immediate();
            refusal(
              yield* Effect.result(observeLabBackendBytes({ path: f.path, genesis })),
              'budget'
            );
          } finally {
            writer.close();
          }
          const missing = join(directory, 'missing.sqlite');
          refusal(
            yield* Effect.result(observeLabBackendBytes({ path: missing, genesis })),
            'storage'
          );
          expect(existsSync(missing)).toBe(false);
          const malformed = join(directory, 'wrong-schema.sqlite');
          const empty = new Database(malformed);
          empty.exec('CREATE TABLE unrelated(value TEXT)');
          empty.close();
          refusal(
            yield* Effect.result(observeLabBackendBytes({ path: malformed, genesis })),
            'storage'
          );
        })
      )
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

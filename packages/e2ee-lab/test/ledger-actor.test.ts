import { runOwnedChild } from './native-child';
import { writeFileSync } from 'node:fs';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Effect, Result } from 'effect';
import { Bytes } from '@lody/e2ee-core';
import { prepareDeviceAdmission } from '@lody/e2ee-core/protocol';
import { hashRecordBytes, verifyLedger } from '@lody/e2ee-core/protocol';
import type { LedgerSubmissionStream } from '@lody/e2ee-core/adapters/loro-streams';
import { expect, it } from 'vitest';
import { StreamsClient } from '@loro-dev/streams-client';
import { LedgerFeedError } from '@lody/e2ee-core';
import { frameLedgerRecord } from '@lody/e2ee-core/protocol';
import { makeLabCredentials } from '../src/platform/credentials';
import { makeLabWorkspaceRegistry } from '../src/platform/workspace-registry';
import { makeLabControlGateway } from '../src/platform/control-gateway';
import { makeLabStreamReader } from '../src/platform/stream-read';
import { makeLabHttpHost } from '../src/platform/host';
import { openLabExistingWorkspace } from '../src/platform/workspace-session';
import { makeLabLedgerActor } from '../src/platform/ledger-actor';
import { fixture, options } from './ledger-fixture';
import { generateDevice, exportDevice } from '../src/platform/device';
const ok = Result.getOrThrow;
async function admission(f: Awaited<ReturnType<typeof fixture>>) {
  const key = createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      Buffer.alloc(32, 61),
    ]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = ok(
    Bytes.signingPublicKey(
      new Uint8Array(createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32))
    )
  );
  return Effect.runPromise(
    prepareDeviceAdmission({
      genesis: f.anchor,
      membershipId: f.membership,
      encryptionPublicKey: ok(Bytes.encryptionPublicKey(new Uint8Array(32).fill(62))),
      kind: 'personal',
      signer: {
        publicKey,
        sign: (message) =>
          Effect.sync(() => ok(Bytes.signature(new Uint8Array(sign(null, message, key))))),
      },
    })
  );
}
function checkpoint(records: readonly Uint8Array[]) {
  return { head: hashRecordBytes(records[records.length - 1]!), length: records.length };
}
it('uses public proposal/signing and unchanged P09; an unacknowledged result forbids new signing', async () => {
  const f = await fixture();
  try {
    const command = await admission(f);
    const originals = [...f.records];
    let signs = 0;
    const stream = {
      read: f.sdk.read.bind(f.sdk),
      appendCas: async (input: Parameters<LedgerSubmissionStream['appendCas']>[0]) => {
        const output = await f.sdk.appendCas(input);
        if (output.ok && output.result.kind === 'ok')
          originals.push(new Uint8Array(input.part.body.subarray(4)));
        return output;
      },
    };
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const actor = yield* makeLabLedgerActor({
            ...options(f, 'create'),
            stream,
            journalPath: join(f.dir, 'pending.sqlite'),
            checkpoint: () => Effect.sync(() => checkpoint(originals)),
            signer: {
              publicKey: f.owner.publicKey,
              sign: (message) => {
                signs++;
                return f.owner.sign(message);
              },
            },
          });
          const result = yield* actor.execute(command);
          expect(result.outcome).toBe('Committed');
          expect(signs).toBe(1);
          expect((yield* actor.current()).view.length).toBe(3);
          const blocked = yield* Effect.result(actor.execute(command));
          expect(Result.isFailure(blocked)).toBe(true);
          expect(signs).toBe(1);
          yield* actor.acknowledge(result);
          expect(yield* actor.resume()).toBeNull();
        })
      )
    );
    expect(
      ok(verifyLedger({ anchor: f.anchor, records: originals, checkpoint: checkpoint(originals) }))
        .length
    ).toBe(3);
  } finally {
    await f.close();
  }
});
it('retains the exact terminal result when feed persistence fails, then resumes without another signature', async () => {
  const f = await fixture();
  try {
    const command = await admission(f);
    const originals = [...f.records];
    let signs = 0;
    let failFeed: () => void = () => {};
    const stream = {
      read: f.sdk.read.bind(f.sdk),
      appendCas: async (input: Parameters<LedgerSubmissionStream['appendCas']>[0]) => {
        const output = await f.sdk.appendCas(input);
        if (output.ok && output.result.kind === 'ok') {
          originals.push(new Uint8Array(input.part.body.subarray(4)));
          failFeed();
        }
        return output;
      },
    };
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const actor = yield* makeLabLedgerActor({
            ...options(f, 'create'),
            stream,
            journalPath: join(f.dir, 'pending.sqlite'),
            checkpoint: () => Effect.sync(() => checkpoint(originals)),
            signer: {
              publicKey: f.owner.publicKey,
              sign: (message) => {
                signs++;
                return f.owner.sign(message);
              },
            },
          });
          yield* actor.refresh();
          const db = new Database(f.path);
          try {
            failFeed = () => {
              db.exec(
                'CREATE TRIGGER deny_feed BEFORE UPDATE ON feed_meta BEGIN SELECT RAISE(IGNORE); END'
              );
            };
            expect(Result.isFailure(yield* Effect.result(actor.execute(command)))).toBe(true);
            // The unchanged P09 terminal row remains present while feed/cursor stays older.
            const result = { outcome: 'Committed' as const, record: originals[2]! };
            expect(Result.isFailure(yield* Effect.result(actor.acknowledge(result)))).toBe(true);
            expect((yield* actor.current()).view.length).toBe(2);
            db.exec('DROP TRIGGER deny_feed');
            expect(signs).toBe(1);
          } finally {
            db.close();
          }
        })
      )
    );
    const config = join(f.dir, 'actor-child.json');
    const endpoint = checkpoint(originals);
    writeFileSync(
      config,
      JSON.stringify({
        path: f.path,
        journalPath: join(f.dir, 'pending.sqlite'),
        url: `${f.server.baseUrl}/ds/synthetic/control`,
        genesis: Buffer.from(f.genesis).toString('hex'),
        anchor: Buffer.from(f.anchor.toBytes()).toString('hex'),
        localHead: Buffer.from(f.checkpoint.head.toBytes()).toString('hex'),
        head: Buffer.from(endpoint.head.toBytes()).toString('hex'),
        length: endpoint.length,
        publicKey: Buffer.from(f.owner.publicKey.toBytes()).toString('hex'),
      }),
      { mode: 0o600 }
    );
    const stdout = await Effect.runPromise(
      runOwnedChild(['--import', 'tsx', 'test/ledger-actor-reopen.mts', config])
    );
    expect(JSON.parse(stdout)).toEqual({
      outcome: 'Committed',
      record: Buffer.from(originals[2]!).toString('hex'),
      length: 3,
      empty: true,
    });
  } finally {
    await f.close();
  }
});

it('opens an admitted workspace through actual HTTP/public SDK, cleans failed acquisition before retry and reopens durable state in another process', async () => {
  const f = await fixture();
  const originals = f.records.map((r) => new Uint8Array(r));
  const currentView = () =>
    ok(verifyLedger({ anchor: f.anchor, records: originals, checkpoint: checkpoint(originals) }));
  try {
    const org = Buffer.from(f.anchor.toBytes()).toString('hex');
    expect((await fetch(`${f.server.baseUrl}/ds/${org}`, { method: 'PUT' })).ok).toBe(true);
    const remote = new StreamsClient({
      url: `${f.server.baseUrl}/ds/${org}/control`,
      retry: { maxAttempts: 1 },
    });
    expect((await remote.create({ contentType: 'application/octet-stream' })).ok).toBe(true);
    for (const record of originals)
      expect(
        (
          await remote.append({
            part: { contentType: 'application/octet-stream', body: ok(frameLedgerRecord(record)) },
          })
        ).ok
      ).toBe(true);
    const tablet = await Effect.runPromise(generateDevice());
    const tabletFixture = await Effect.runPromise(exportDevice(tablet));
    expect(tablet.publicKey.equals(f.owner.publicKey)).toBe(false);
    const command = await Effect.runPromise(
      prepareDeviceAdmission({
        genesis: f.anchor,
        membershipId: f.membership,
        kind: 'personal',
        encryptionPublicKey: tablet.enc,
        signer: tablet,
      })
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* makeLabWorkspaceRegistry({
            path: join(f.dir, 'session-registry.sqlite'),
            mode: 'create',
          });
          yield* registry.register(
            {
              token: 'synthetic',
              account: 'synthetic-owner',
              device: f.owner.publicKey,
              genesis: null,
              issuedAt: 0,
              expiresAt: 100,
            },
            f.genesis
          );
          const credentials = yield* makeLabCredentials({
            path: join(f.dir, 'session-credentials.sqlite'),
            mode: 'create',
            now: () => 0,
            ledger: () => Effect.sync(currentView),
          });
          const reader = yield* makeLabStreamReader({
            genesis: f.anchor,
            baseUrl: f.server.baseUrl,
            maxBytes: 1024 * 1024,
            ledger: () => Effect.sync(currentView),
          });
          const gateway = yield* makeLabControlGateway({
            genesis: f.anchor,
            now: () => 0,
            checkpoint: () => Effect.sync(() => checkpoint(originals)),
            budget: { maxRecords: 100, maxBytes: 1024 * 1024 },
            stream: {
              read: remote.read.bind(remote),
              appendCas: async (input) => {
                const out = await remote.appendCas(input);
                if (out.ok && out.result.kind === 'ok')
                  originals.push(new Uint8Array(input.part.body.subarray(4)));
                return out;
              },
            },
          });
          const host = yield* makeLabHttpHost({
            credentials,
            workspaces: registry,
            streams: () => reader,
            control: () => gateway,
          });
          const path = join(f.dir, 'session-feed.sqlite'),
            journalPath = join(f.dir, 'session-journal.sqlite');
          let attack: 'duplicate' | 'old-prefix' | undefined;
          let served: { bytes: Uint8Array; requestedOffset: string | null } | undefined;
          const observedResponse = () => served;
          const transport: typeof fetch = async (url, init) => {
            const target = new URL(url instanceof Request ? url.url : String(url));
            if (
              attack &&
              (init?.method ?? (url instanceof Request ? url.method : 'GET')) === 'GET' &&
              target.pathname === `/ds/${org}/control`
            ) {
              // Duplicate is at the client's current native offset; rollback ignores it.
              // Do not forward the product bearer to the fixture's raw transport.
              const requestedOffset = target.searchParams.get('offset');
              const offset = attack === 'duplicate' ? requestedOffset! : '-1';
              const response = await fetch(
                `${f.server.baseUrl}/ds/${org}/${attack}?offset=${encodeURIComponent(offset)}`,
                {
                  method: 'GET',
                  signal: init?.signal,
                  redirect: 'manual',
                }
              );
              const bytes = new Uint8Array(await response.arrayBuffer());
              served = { bytes, requestedOffset };
              return new Response(bytes, { status: response.status, headers: response.headers });
            }
            return fetch(url, init);
          };
          const input = {
            baseUrl: host.baseUrl,
            genesis: f.anchor,
            signer: f.owner,
            path,
            journalPath,
            budget: { maxRecords: 100, maxBytes: 1024 * 1024 },
            checkpoint: () => Effect.sync(() => checkpoint(originals)),
            fetch: transport,
          };
          const closed = new Set<string>();
          const nativeClose = Database.prototype.close;
          Database.prototype.close = function () {
            const result = nativeClose.call(this);
            if ((this.name === path || this.name === journalPath) && !this.open)
              closed.add(this.name);
            return result;
          };
          try {
            const failed = yield* Effect.result(
              openLabExistingWorkspace({
                ...input,
                mode: 'create',
                checkpoint: () => Effect.fail(new LedgerFeedError({ code: 'wrong-parent' })),
              })
            );
            expect(Result.isFailure(failed)).toBe(true);
            // Parent Scope and genuine HTTP host are still live. Actual SQLite handles
            // closed on failed startup, rather than waiting for parent teardown.
            expect(closed.has(path)).toBe(true);
            expect(closed.has(journalPath)).toBe(true);
          } finally {
            Database.prototype.close = nativeClose;
          }
          const session = yield* openLabExistingWorkspace({
            ...input,
            mode: 'open',
            expected: { head: hashRecordBytes(f.genesis), length: 1 },
          });
          expect((yield* session.control.current()).view.length).toBe(2);
          const exposed = session.genesisRecord();
          exposed.fill(0);
          expect(session.genesisRecord()).toEqual(f.genesis);
          const result = yield* session.control.execute(command);
          expect(result.outcome).toBe('Committed');
          const saved = yield* session.control.current();
          expect(saved.view.length).toBe(3);
          expect(saved.view.head.equals(checkpoint(originals).head)).toBe(true);
          yield* session.control.acknowledge(result);
          const healthyPath = join(f.dir, 'healthy-feed.sqlite');
          const healthy = yield* openLabExistingWorkspace({
            ...input,
            path: healthyPath,
            signer: tablet,
            journalPath: join(f.dir, 'healthy-journal.sqlite'),
            mode: 'create',
            fetch,
          });
          const credentialsDb = new Database(join(f.dir, 'session-credentials.sqlite'), {
            readonly: true,
          });
          try {
            const devices = credentialsDb
              .prepare('SELECT DISTINCT device_hex FROM credentials WHERE genesis_hex=?')
              .all(org) as { device_hex: string }[];
            expect(devices.map((row) => row.device_hex)).toContain(
              Buffer.from(tablet.publicKey.toBytes()).toString('hex')
            );
            expect(devices.map((row) => row.device_hex)).toContain(
              Buffer.from(f.owner.publicKey.toBytes()).toString('hex')
            );
          } finally {
            credentialsDb.close();
          }
          const persisted = (file: string) => {
            const db = new Database(file, { readonly: true });
            try {
              return {
                meta: db.prepare('SELECT * FROM feed_meta').all(),
                records: db.prepare('SELECT * FROM feed_records ORDER BY position').all(),
              };
            } finally {
              db.close();
            }
          };
          const before = persisted(path),
            healthyBefore = persisted(healthyPath);
          for (const scenario of ['duplicate', 'old-prefix'] as const) {
            const poisoned = new StreamsClient({
              url: `${f.server.baseUrl}/ds/${org}/${scenario}`,
              retry: { maxAttempts: 1 },
            });
            expect(
              (yield* Effect.promise(() =>
                poisoned.create({ contentType: 'application/octet-stream' })
              )).ok
            ).toBe(true);
            const entries =
              scenario === 'duplicate' ? [...originals, originals[1]!] : originals.slice(0, 2);
            for (const entry of entries)
              expect(
                (yield* Effect.promise(() =>
                  poisoned.append({
                    part: {
                      contentType: 'application/octet-stream',
                      body: ok(frameLedgerRecord(entry)),
                    },
                  })
                )).ok
              ).toBe(true);
            attack = scenario;
            served = undefined;
            expect(Result.isFailure(yield* Effect.result(session.control.refresh()))).toBe(true);
            const observed = observedResponse();
            expect(observed?.requestedOffset).toBe(saved.offset);
            const expectedBytes =
              scenario === 'duplicate'
                ? ok(frameLedgerRecord(originals[1]!))
                : Buffer.concat(
                    originals.slice(0, 2).map((entry) => Buffer.from(ok(frameLedgerRecord(entry))))
                  );
            expect(Buffer.from(observed!.bytes)).toEqual(Buffer.from(expectedBytes));
            const retained = yield* session.control.current();
            expect(retained.offset).toBe(saved.offset);
            expect(retained.view.head.equals(saved.view.head)).toBe(true);
            expect(retained.view.length).toBe(saved.view.length);
            expect(persisted(path)).toEqual(before);
            // Another simultaneously live owner uses its own database and real route.
            const other = yield* healthy.control.refresh();
            expect(other.view.head.equals(saved.view.head)).toBe(true);
            expect(other.view.length).toBe(3);
            expect(persisted(healthyPath)).toEqual(healthyBefore);
            const faultManifest = join(f.dir, `${scenario}-child.json`);
            const head = Buffer.from(saved.view.head.toBytes()).toString('hex');
            writeFileSync(
              faultManifest,
              JSON.stringify({
                baseUrl: host.baseUrl,
                path,
                journalPath,
                anchor: org,
                head,
                length: saved.view.length,
                offset: saved.offset,
              }),
              { mode: 0o600 }
            );
            const reopened = yield* runOwnedChild([
              '--import',
              'tsx',
              'test/workspace-session-reopen.mts',
              faultManifest,
            ]);
            expect(JSON.parse(reopened)).toEqual({
              length: 3,
              head,
              offset: saved.offset,
              pending: false,
            });
            expect(persisted(path)).toEqual(before);
            attack = undefined;
            const retry = yield* session.control.refresh();
            expect(retry.offset).toBe(saved.offset);
            expect(retry.view.head.equals(saved.view.head)).toBe(true);
            expect(persisted(path)).toEqual(before);
          }
          yield* healthy.close();
          const tabletManifest = join(f.dir, 'tablet-child.json');
          writeFileSync(
            tabletManifest,
            JSON.stringify({
              baseUrl: host.baseUrl,
              path: healthyPath,
              journalPath: join(f.dir, 'healthy-journal.sqlite'),
              anchor: org,
              head: Buffer.from(saved.view.head.toBytes()).toString('hex'),
              length: 3,
              offset: (yield* session.control.current()).offset,
              device: tabletFixture,
            }),
            { mode: 0o600 }
          );
          const tabletOutput = yield* runOwnedChild([
            '--import',
            'tsx',
            'test/workspace-session-reopen.mts',
            tabletManifest,
          ]);
          expect(JSON.parse(tabletOutput)).toEqual({
            device: Buffer.from(tablet.publicKey.toBytes()).toString('hex'),
            length: 3,
            head: Buffer.from(saved.view.head.toBytes()).toString('hex'),
            offset: saved.offset,
            pending: false,
          });
          yield* session.close();
          yield* session.close();
          expect(Result.isFailure(yield* Effect.result(session.control.refresh()))).toBe(true);
          expect(Result.isFailure(yield* Effect.result(session.identity.listJoins()))).toBe(true);
          const manifest = join(f.dir, 'session-child.json');
          writeFileSync(
            manifest,
            JSON.stringify({
              baseUrl: host.baseUrl,
              path,
              journalPath,
              anchor: org,
              head: Buffer.from(saved.view.head.toBytes()).toString('hex'),
              length: 3,
              offset: saved.offset,
            })
          );
          const output = yield* runOwnedChild([
            '--import',
            'tsx',
            'test/workspace-session-reopen.mts',
            manifest,
          ]);
          expect(JSON.parse(output)).toEqual({
            length: 3,
            head: Buffer.from(saved.view.head.toBytes()).toString('hex'),
            offset: saved.offset,
            pending: false,
          });
          // Closing either client never publishes SDK EOF: actual remote read still works.
          const after = yield* Effect.tryPromise({
            try: () => remote.read({ offset: '0' }),
            catch: (e) => e,
          });
          expect(after.ok).toBe(true);
        })
      )
    );
  } finally {
    await f.close();
  }
});

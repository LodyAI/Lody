import { StreamsClient } from '@loro-dev/streams-client';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { join } from 'node:path';
import {
  createServer,
  IncomingMessage,
  request as httpRequest,
  type ClientRequest,
} from 'node:http';
import Database from 'better-sqlite3';
import { Effect, Exit, Fiber, Result, Scope } from 'effect';
import { describe, expect, it } from 'vitest';
import { Bytes } from '@lody/e2ee-core';
import { decodeCbor, encodeCbor, verifySignature, type CborValue } from '@lody/e2ee-core/protocol';
import { hashRecordBytes, verifyLedger, recordSigningBytes } from '@lody/e2ee-core/protocol';
import { prepareDeviceAdmission, prepareLedgerCommand } from '@lody/e2ee-core/protocol';
import { signLedgerRecord } from '@lody/e2ee-core/protocol';
import { frameLedgerRecord } from '@lody/e2ee-core/protocol';
import { fixture } from './ledger-fixture';
import { makeLabCredentials, labPossessionMessage } from '../src/platform/credentials';
import { makeLabControlGateway } from '../src/platform/control-gateway';
import { makeLabHttpHost } from '../src/platform/host';
import { makeLabHttpIdentity } from '../src/platform/http-identity';
import { authorizeLabStream } from '../src/platform/gateway';
const ok = Result.getOrThrow;
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
function syntheticSigner(seed: number) {
  const privateKey = createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      Buffer.alloc(32, seed),
    ]),
    format: 'der',
    type: 'pkcs8',
  });
  return {
    publicKey: ok(
      Bytes.signingPublicKey(
        new Uint8Array(
          createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32)
        )
      )
    ),
    sign: (message: Uint8Array) =>
      Effect.sync(() => ok(Bytes.signature(new Uint8Array(sign(null, message, privateKey))))),
  };
}
describe('real loopback Lab credentials and control HTTP composition', () => {
  it('authenticates possession and current Org, rejects malformed routes/records, pins actual SDK CAS despite hostile headers and refuses replay/expired tokens', async () => {
    const f = await fixture();
    let now = 10;
    const originals = [...f.records];
    const currentView = () =>
      ok(
        verifyLedger({
          anchor: f.anchor,
          records: originals,
          checkpoint: { head: hashRecordBytes(originals.at(-1)!), length: originals.length },
        })
      );
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const credentials = yield* makeLabCredentials({
              path: join(f.dir, 'http-credentials.sqlite'),
              mode: 'create',
              now: () => now,
              ledger: (anchor) =>
                anchor.equals(f.anchor) ? Effect.sync(currentView) : Effect.fail('unknown Org'),
            });
            const gateway = yield* makeLabControlGateway({
              genesis: f.anchor,
              now: () => now,
              checkpoint: () =>
                Effect.sync(() => ({
                  head: hashRecordBytes(originals.at(-1)!),
                  length: originals.length,
                })),
              budget: { maxRecords: 100, maxBytes: 1024 * 1024 },
              stream: {
                read: f.sdk.read.bind(f.sdk),
                appendCas: async (request) => {
                  const result = await f.sdk.appendCas(request);
                  if (result.ok && result.result.kind === 'ok')
                    originals.push(new Uint8Array(request.part.body.subarray(4)));
                  return result;
                },
              },
            });
            const host = yield* makeLabHttpHost({
              credentials,
              control: (anchor) => (anchor.equals(f.anchor) ? gateway : undefined),
            });
            const post = (path: string, value: unknown) =>
              Effect.promise(() =>
                fetch(host.baseUrl + path, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify(value),
                })
              );
            const deviceHex = hex(f.owner.publicKey.toBytes()),
              account = 'synthetic-http-alice';
            const challenge = yield* post('/v1/credentials/challenge', { account, deviceHex });
            expect(challenge.status).toBe(200);
            const { nonce } = (yield* Effect.promise(() => challenge.json())) as { nonce: string };
            const proof = {
              account,
              deviceHex,
              nonce,
              genesisHex: hex(f.anchor.toBytes()),
              ttlMs: 100,
              signature: hex(
                (yield* f.owner.sign(
                  ok(labPossessionMessage(account, f.owner.publicKey, nonce))
                )).toBytes()
              ),
            };
            const minted = yield* post('/v1/credentials', proof);
            expect(minted.status).toBe(200);
            const { token } = (yield* Effect.promise(() => minted.json())) as { token: string };
            expect((yield* post('/v1/credentials', proof)).status).toBe(403);
            const signer = syntheticSigner(119);
            const command = yield* prepareDeviceAdmission({
              genesis: f.anchor,
              membershipId: f.membership,
              encryptionPublicKey: ok(Bytes.encryptionPublicKey(new Uint8Array(32).fill(120))),
              kind: 'personal',
              signer,
            });
            const record = yield* signLedgerRecord(
              ok(prepareLedgerCommand(f.view, f.owner.publicKey, command)),
              f.owner
            );
            const frame = ok(frameLedgerRecord(record));
            const path = `/ds/${hex(f.anchor.toBytes())}/control/append-cas`;
            const append = (route: string, bytes: Uint8Array, credential?: string) =>
              Effect.promise(() =>
                fetch(host.baseUrl + route, {
                  method: 'POST',
                  headers: {
                    ...(credential ? { authorization: `Bearer ${credential}` } : {}),
                    'Stream-Expected-Offset': '0',
                    'Stream-Closed': 'true',
                    'Stream-TTL': '1',
                    'Stream-Seq': 'hostile',
                    'content-type': 'application/octet-stream',
                  },
                  body: Buffer.from(bytes),
                })
              );
            expect((yield* append(path, frame)).status).toBe(401);
            expect((yield* append(path + '?offset=0', frame, token)).status).toBe(404);
            expect(
              (yield* append(path.replace(hex(f.anchor.toBytes()), 'aa'.repeat(32)), frame, token))
                .status
            ).toBe(404);
            expect((yield* append(path, new Uint8Array([...frame, ...frame]), token)).status).toBe(
              400
            );
            const bad = frame.slice();
            bad[bad.length - 1] ^= 1;
            expect((yield* append(path, bad, token)).status).toBe(403);
            expect(originals.length).toBe(2);
            const consumer = new StreamsClient({
              url: host.baseUrl + path.replace('/append-cas', ''),
              auth: token,
              headers: { 'Stream-Closed': 'true', 'Stream-TTL': '1' },
              retry: { maxAttempts: 1 },
            });
            const accepted = yield* Effect.promise(() =>
              consumer.appendCas({
                expectedOffset: '0',
                part: { contentType: 'application/octet-stream', body: frame },
              })
            );
            expect(accepted.ok).toBe(true);
            if (!accepted.ok || accepted.result.kind !== 'ok')
              throw new Error('published SDK rejected host acknowledgement');
            expect(typeof accepted.result.value.nextOffset).toBe('string');
            expect(originals.length).toBe(3);
            expect(originals.at(-1)).toEqual(record);
            expect((yield* append(path, frame, token)).status).toBe(403);
            // A real SDK read proves hostile lifecycle headers did not close/delete the stream.
            const readable = yield* Effect.promise(() => f.sdk.read({ offset: '0' }));
            expect(readable.ok).toBe(true);
            // Real current-ledger authentication, not a credential fixture shortcut.
            const mint = (device: ReturnType<typeof syntheticSigner>) =>
              Effect.gen(function* () {
                const recoveryAccount = 'synthetic-http-recovery';
                const recoveryDeviceHex = hex(device.publicKey.toBytes());
                const response = yield* post('/v1/credentials/challenge', {
                  account: recoveryAccount,
                  deviceHex: recoveryDeviceHex,
                });
                expect(response.status).toBe(200);
                const { nonce: recoveryNonce } = (yield* Effect.promise(() => response.json())) as {
                  nonce: string;
                };
                const response2 = yield* post('/v1/credentials', {
                  account: recoveryAccount,
                  deviceHex: recoveryDeviceHex,
                  nonce: recoveryNonce,
                  genesisHex: hex(f.anchor.toBytes()),
                  ttlMs: 100,
                  signature: hex(
                    (yield* device.sign(
                      ok(labPossessionMessage(recoveryAccount, device.publicKey, recoveryNonce))
                    )).toBytes()
                  ),
                });
                expect(response2.status).toBe(200);
                return ((yield* Effect.promise(() => response2.json())) as { token: string }).token;
              });
            const recovery = syntheticSigner(121),
              newPersonal = syntheticSigner(122);
            const recoveryCommand = yield* prepareDeviceAdmission({
              genesis: f.anchor,
              membershipId: f.membership,
              kind: 'recovery',
              signer: recovery,
              encryptionPublicKey: ok(Bytes.encryptionPublicKey(new Uint8Array(32).fill(123))),
            });
            const recoveryRecord = yield* signLedgerRecord(
              ok(prepareLedgerCommand(currentView(), f.owner.publicKey, recoveryCommand)),
              f.owner
            );
            expect((yield* append(path, ok(frameLedgerRecord(recoveryRecord)), token)).status).toBe(
              200
            );
            const recoveryToken = yield* mint(recovery);
            const personalCommand = yield* prepareDeviceAdmission({
              genesis: f.anchor,
              membershipId: f.membership,
              kind: 'personal',
              signer: newPersonal,
              encryptionPublicKey: ok(Bytes.encryptionPublicKey(new Uint8Array(32).fill(124))),
            });
            const personalRecord = yield* signLedgerRecord(
              ok(prepareLedgerCommand(currentView(), recovery.publicKey, personalCommand)),
              recovery
            );
            // Raw adversarial vectors only: public encoding and signature domain. The
            // public preparer correctly refuses these, so it cannot construct attacks.
            const root = ok(decodeCbor(personalRecord)) as CborValue[];
            const body = root[0] as CborValue[];
            const operation = body[2] as CborValue[];
            const signedAttack = (replacement: CborValue[]) =>
              Effect.gen(function* () {
                const attackBody = [body[0]!, body[1]!, replacement];
                const encoded = ok(encodeCbor(attackBody));
                const signature = yield* recovery.sign(recordSigningBytes(encoded));
                expect(
                  ok(
                    verifySignature(
                      recovery.publicKey.toBytes(),
                      recordSigningBytes(encoded),
                      signature.toBytes()
                    )
                  )
                ).toBeUndefined();
                return ok(encodeCbor([attackBody, signature.toBytes()]));
              });
            const before = originals.map((stored) => new Uint8Array(stored));
            const beforeRead = yield* Effect.promise(() => f.sdk.read({ offset: '0' }));
            expect(beforeRead.ok).toBe(true);
            if (!beforeRead.ok) throw new Error('native stream read failed');
            const otherMembership = ok(Bytes.membershipId(new Uint8Array(16).fill(125)));
            const foreignProof = yield* prepareDeviceAdmission({
              genesis: f.anchor,
              membershipId: otherMembership,
              kind: 'personal',
              signer: newPersonal,
              encryptionPublicKey: ok(Bytes.encryptionPublicKey(new Uint8Array(32).fill(124))),
            });
            const foreignOperation = [...operation];
            foreignOperation[4] = foreignProof.possessionSignature.toBytes();
            const attacks = [
              yield* signedAttack(foreignOperation),
              yield* signedAttack([operation[0]!, 1, ...operation.slice(2)]),
              yield* signedAttack([operation[0]!, 2, ...operation.slice(2)]),
              yield* signedAttack([5, f.owner.publicKey.toBytes()]),
              record, // Owner's valid record is not this authenticated R's signature.
            ];
            const badPersonal = personalRecord.slice();
            badPersonal[badPersonal.length - 1] ^= 1;
            attacks.push(badPersonal);
            const routePermission = (controlRecord: Uint8Array) =>
              authorizeLabStream({
                view: currentView(),
                authenticatedCredential: { device: recovery.publicKey, genesis: f.anchor },
                requestGenesis: f.anchor,
                stream: 'control',
                method: 'POST',
                sub: 'append-cas',
                controlRecord,
              });
            // The foreign-member PoP reaches public submission verification; shape
            // screening and a valid outer R signature are not admission evidence.
            expect(ok(routePermission(attacks[0]!))).toBeUndefined();
            for (const attack of attacks.slice(1, 5))
              expect(Result.isFailure(routePermission(attack))).toBe(true);
            for (const attack of attacks) {
              expect(
                (yield* append(path, ok(frameLedgerRecord(attack)), recoveryToken)).status
              ).toBe(403);
              expect(originals).toEqual(before);
            }
            const afterRead = yield* Effect.promise(() => f.sdk.read({ offset: '0' }));
            expect(afterRead.ok).toBe(true);
            if (!afterRead.ok) throw new Error('native stream read failed after refusal');
            expect(afterRead.result.nextOffset).toBe(beforeRead.result.nextOffset);
            expect(afterRead.result.payload.body).toEqual(beforeRead.result.payload.body);
            const recoveryConsumer = new StreamsClient({
              url: host.baseUrl + path.replace('/append-cas', ''),
              auth: recoveryToken,
              retry: { maxAttempts: 1 },
            });
            const recovered = yield* Effect.promise(() =>
              recoveryConsumer.appendCas({
                expectedOffset: '0',
                part: {
                  contentType: 'application/octet-stream',
                  body: ok(frameLedgerRecord(personalRecord)),
                },
              })
            );
            expect(recovered.ok).toBe(true);
            if (!recovered.ok || recovered.result.kind !== 'ok')
              throw new Error('R admission was refused');
            expect(originals.at(-1)).toEqual(personalRecord);
            const admitted = currentView()
              .inspectState()
              .devices.get(hex(newPersonal.publicKey.toBytes()));
            expect(admitted?.kind).toBe('personal');
            expect(admitted?.membershipId.equals(f.membership)).toBe(true);
            const revoke = yield* signLedgerRecord(
              ok(
                prepareLedgerCommand(currentView(), f.owner.publicKey, {
                  _tag: 'RevokeDevice',
                  target: recovery.publicKey,
                })
              ),
              f.owner
            );
            expect((yield* append(path, ok(frameLedgerRecord(revoke)), token)).status).toBe(200);
            const finalHistory = originals.map((stored) => new Uint8Array(stored));
            expect(
              (yield* append(path, ok(frameLedgerRecord(personalRecord)), recoveryToken)).status
            ).toBe(403);
            expect(originals).toEqual(finalHistory);
            now = 110;
            expect((yield* append(path, frame, token)).status).toBe(403);
            expect(originals).toEqual(finalHistory);
          })
        )
      );
    } finally {
      await f.close();
    }
  });
  it('aborts an unfinished real HTTP body before awaiting callback shutdown', async () => {
    const f = await fixture();
    const scope = Scope.makeUnsafe();
    const iterate = IncomingMessage.prototype[Symbol.asyncIterator];
    let request: ClientRequest | undefined;
    let closing: Fiber.Fiber<void> | undefined;
    let entered!: (incoming: IncomingMessage) => void;
    let rejectEntered!: (error: Error) => void;
    const bodyEntered = new Promise<IncomingMessage>((resolve, reject) => {
      entered = resolve;
      rejectEntered = reject;
    });
    // Observe the real body boundary without replacing or delaying its iterator.
    IncomingMessage.prototype[Symbol.asyncIterator] = function () {
      if (this.url === '/v1/credentials/challenge') entered(this);
      return iterate.call(this);
    };
    try {
      const host = await Effect.runPromise(
        Effect.gen(function* () {
          const credentials = yield* makeLabCredentials({
            path: join(f.dir, 'unfinished-body-credentials.sqlite'),
            mode: 'create',
            now: () => 0,
            ledger: () => Effect.succeed(f.view),
          });
          return yield* makeLabHttpHost({ credentials, control: () => undefined });
        }).pipe(Effect.provideService(Scope.Scope, scope))
      );
      request = httpRequest(host.baseUrl + '/v1/credentials/challenge', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': '2' },
      });
      request.on('error', rejectEntered);
      request.on('response', (response) => response.resume());
      request.write('{'); // Deliberately leave the native request body unfinished.
      const incoming = await bodyEntered;
      const socketClosed = new Promise<void>((resolve) =>
        incoming.socket.once('close', () => resolve())
      );
      // runFork starts synchronously: abort admission must precede the first
      // asynchronous callback-close wait, rather than waiting for the missing byte.
      closing = Effect.runFork(Scope.close(scope, Exit.void));
      expect(incoming.destroyed).toBe(true);
      await Effect.runPromise(Fiber.join(closing));
      await socketClosed;
      expect(incoming.socket.destroyed).toBe(true);
    } finally {
      // Also release the old-order failure before joining its exact close fiber.
      request?.destroy();
      try {
        if (closing) await Effect.runPromise(Fiber.join(closing));
        else await Effect.runPromise(Scope.close(scope, Exit.void));
      } finally {
        IncomingMessage.prototype[Symbol.asyncIterator] = iterate;
        await f.close();
      }
    }
  });
});

describe('public Lab credential client on actual local HTTP', () => {
  it('owns signer binding, rejects altered receipts, bounds response bodies and never forwards bearer to another origin or after close', async () => {
    const f = await fixture();
    let retained:
      | Effect.Success<
          ReturnType<Effect.Success<ReturnType<typeof makeLabHttpIdentity>>['authenticate']>
        >
      | undefined;
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const credentials = yield* makeLabCredentials({
              path: join(f.dir, 'client-credentials.sqlite'),
              mode: 'create',
              now: () => 0,
              ledger: () => Effect.succeed(f.view),
            });
            const host = yield* makeLabHttpHost({ credentials, control: () => undefined });
            const receivedBearers: string[] = [];
            const sink = yield* Effect.acquireRelease(
              Effect.tryPromise({
                try: () =>
                  new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
                    const server = createServer((request, response) => {
                      if (request.headers.authorization)
                        receivedBearers.push(request.headers.authorization);
                      response.end('synthetic sink');
                    });
                    server.once('error', reject);
                    server.listen(0, '127.0.0.1', () => resolve(server));
                  }),
                catch: (error) => error,
              }),
              (server) =>
                Effect.promise(
                  () =>
                    new Promise<void>((resolve, reject) =>
                      server.close((error) => (error ? reject(error) : resolve()))
                    )
                )
            );
            const address = sink.address();
            if (!address || typeof address === 'string') throw new Error('sink has no TCP address');
            const sinkUrl = `http://127.0.0.1:${address.port}/`;
            let alteration = '',
              cancelled = false;
            const mutable = { publicKey: f.owner.publicKey, sign: f.owner.sign };
            const other = syntheticSigner(126);
            const transport: typeof fetch = async (request, init) => {
              const response = await fetch(request, init);
              const target = request instanceof Request ? request.url : String(request);
              if (target.endsWith('/challenge') && alteration === 'mutate-signer') {
                mutable.publicKey = other.publicKey;
                mutable.sign = other.sign;
              }
              if (target.endsWith('/challenge') && alteration === 'oversized') {
                await response.body?.cancel();
                return new Response(
                  new ReadableStream<Uint8Array>({
                    start(controller) {
                      controller.enqueue(new Uint8Array(16385));
                    },
                    cancel() {
                      cancelled = true;
                    },
                  })
                );
              }
              if (!alteration || alteration === 'mutate-signer') return response;
              const value = (await response.json()) as Record<string, unknown>;
              if (target.endsWith('/challenge') && alteration === 'nonce')
                value.nonce = 'malformed';
              if (target.endsWith('/credentials')) {
                if (alteration === 'account') value.account = 'synthetic-other';
                if (alteration === 'device') value.deviceHex = hex(other.publicKey.toBytes());
                if (alteration === 'org') value.genesisHex = 'ff'.repeat(32);
                if (alteration === 'token') value.token = 'malformed';
                if (alteration === 'time') value.expiresAt = value.issuedAt;
              }
              return new Response(JSON.stringify(value), { status: response.status });
            };
            const identity = yield* makeLabHttpIdentity({
              baseUrl: host.baseUrl,
              genesis: f.anchor,
              fetch: transport,
            });
            alteration = 'mutate-signer';
            retained = yield* identity.authenticate(mutable);
            const ordinaryUnbound = yield* identity.authenticate(f.owner, 'unbound');
            expect(ordinaryUnbound.url).toBe(retained.url);
            alteration = '';
            const foreign = yield* Effect.result(
              Effect.tryPromise({ try: () => retained!.fetch(sinkUrl), catch: (error) => error })
            );
            expect(receivedBearers).toEqual([]);
            expect(Result.isFailure(foreign)).toBe(true);
            for (const mode of ['account', 'device', 'org', 'token', 'time', 'nonce']) {
              alteration = mode;
              expect(Result.isFailure(yield* Effect.result(identity.authenticate(f.owner)))).toBe(
                true
              );
            }
            const db = yield* Effect.acquireRelease(
              Effect.sync(
                () =>
                  new Database(join(f.dir, 'client-credentials.sqlite'), {
                    fileMustExist: true,
                    readonly: true,
                  })
              ),
              (handle) => Effect.sync(() => handle.close())
            );
            const before = db.prepare('SELECT count(*) AS n FROM credentials').get();
            alteration = 'oversized';
            const oversized = yield* Effect.result(identity.authenticate(f.owner));
            expect(Result.isFailure(oversized)).toBe(true);
            expect(cancelled).toBe(true);
            expect(db.prepare('SELECT count(*) AS n FROM credentials').get()).toEqual(before);
          })
        )
      );
      expect(retained).toBeDefined();
      await expect(retained!.fetch(retained!.url)).rejects.toMatchObject({ code: 'closed' });
      const afterClose = await Effect.runPromise(Effect.result(retained!.discoverGenesis()));
      expect(Result.isFailure(afterClose)).toBe(true);
    } finally {
      await f.close();
    }
  });
});

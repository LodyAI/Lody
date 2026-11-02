import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { join } from 'node:path';
import { Effect, Exit, Fiber, Result, Scope } from 'effect';
import { describe, expect, it } from 'vitest';
import { Bytes } from '@lody/e2ee-core';
import { encodeCbor } from '@lody/e2ee-core/protocol';
import { type LedgerView } from '@lody/e2ee-core';
import { hashRecordBytes } from '@lody/e2ee-core/protocol';
import {
  prepareDeviceAdmission,
  prepareJoinRequest,
  prepareLedgerCommand,
} from '@lody/e2ee-core/protocol';
import type { LedgerSubmissionStream } from '@lody/e2ee-core/adapters/loro-streams';
import { authorizeLabStream } from '../src/platform/gateway';
import { makeLabControlGateway } from '../src/platform/control-gateway';
import { makeLedgerStreamReader } from '@lody/e2ee-core/adapters/loro-streams';
import { signLedgerRecord } from '@lody/e2ee-core/protocol';
import { makeLabLedgerActor } from '../src/platform/ledger-actor';
import { fixture, options, history } from './ledger-fixture';
const ok = Result.getOrThrow;
function assertDenied(
  result: ReturnType<typeof authorizeLabStream>,
  code: 'unauthorized' | 'unknown-stream' | 'method-not-allowed',
  status = 403
) {
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) expect(result.failure).toMatchObject({ status, code });
}
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
describe('genuine ledger Lab gateway policy (HTTP authentication not implemented here)', () => {
  it('binds the request Org and refuses structural fake authority, outsider devices and unknown/mutating routes', () => {
    const f = history();
    const input = {
      view: f.view,
      authenticatedCredential: { device: f.owner.publicKey, genesis: f.anchor },
      requestGenesis: f.anchor,
      stream: 'loro',
      method: 'GET',
    };
    expect(ok(authorizeLabStream(input))).toBeUndefined();
    for (const stream of ['control', 'loro', 'flock'])
      for (const method of ['GET', 'HEAD'])
        for (const sub of [undefined, 'snapshot', 'bootstrap'])
          expect(ok(authorizeLabStream({ ...input, stream, method, sub }))).toBeUndefined();
    expect(
      Result.isFailure(
        authorizeLabStream({
          ...input,
          authenticatedCredential: { device: syntheticSigner(86).publicKey, genesis: null },
        })
      )
    ).toBe(true);
    expect(
      Result.isFailure(
        authorizeLabStream({
          ...input,
          requestGenesis: ok(Bytes.genesisHash(new Uint8Array(32).fill(87))),
        })
      )
    ).toBe(true);
    expect(
      Result.isFailure(
        authorizeLabStream({
          ...input,
          authenticatedCredential: {
            ...input.authenticatedCredential,
            genesis: ok(Bytes.genesisHash(new Uint8Array(32).fill(87))),
          },
        })
      )
    ).toBe(true);
    const wrong = ok(Bytes.genesisHash(new Uint8Array(32).fill(87)));
    const counterfeitBound = {
      toBytes: () => wrong.toBytes(),
      equals: () => true,
    } as unknown as Bytes.GenesisHash;
    expect(
      Result.isFailure(
        authorizeLabStream({
          ...input,
          authenticatedCredential: { ...input.authenticatedCredential, genesis: counterfeitBound },
        })
      )
    ).toBe(true);
    const brokenRequest = {
      toBytes: () => {
        throw new Error('hostile getter');
      },
    } as unknown as Bytes.GenesisHash;
    expect(Result.isFailure(authorizeLabStream({ ...input, requestGenesis: brokenRequest }))).toBe(
      true
    );
    const forged = {
      genesis: f.anchor,
      inspectState: () => f.view.inspectState(),
    } as unknown as LedgerView;
    expect(Result.isFailure(authorizeLabStream({ ...input, view: forged }))).toBe(true);
    assertDenied(authorizeLabStream({ ...input, method: 'DELETE' }), 'method-not-allowed');
    assertDenied(authorizeLabStream({ ...input, stream: 'unknown' }), 'unknown-stream', 404);
    for (const method of ['GET', 'HEAD', 'POST', 'PUT'])
      assertDenied(authorizeLabStream({ ...input, stream: 'keys', method }), 'unknown-stream', 404);
    expect(
      ok(authorizeLabStream({ ...input, stream: 'control', method: 'POST', sub: 'append-cas' }))
    ).toBeUndefined();
    for (const [stream, method, sub] of [
      ['loro', 'POST', undefined],
      ['loro', 'POST', 'append-cas'],
      ['flock', 'POST', undefined],
      ['flock', 'POST', 'append-cas'],
      ['loro', 'PUT', 'snapshot'],
      ['flock', 'PUT', 'snapshot'],
      ['control', 'GET', 'append-cas'],
      ['control', 'HEAD', 'append-cas'],
    ] as const)
      assertDenied(authorizeLabStream({ ...input, stream, method, sub }), 'method-not-allowed');
  });
  it('uses real public admission, SDK CAS and durable feed for current Recovery/machine roles and revocation', async () => {
    const f = await fixture();
    try {
      const originals = [...f.records];
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
              journalPath: join(f.dir, 'gateway-pending.sqlite'),
              checkpoint: () =>
                Effect.sync(() => ({
                  head: hashRecordBytes(originals[originals.length - 1]!),
                  length: originals.length,
                })),
              signer: f.owner,
            });
            const recovery = syntheticSigner(88),
              machine = syntheticSigner(89);
            for (const [signer, kind, enc] of [
              [recovery, 'recovery', 90],
              [machine, 'machine', 91],
            ] as const) {
              const consent = yield* prepareDeviceAdmission({
                genesis: f.anchor,
                membershipId: f.membership,
                encryptionPublicKey: ok(Bytes.encryptionPublicKey(new Uint8Array(32).fill(enc))),
                kind,
                ...(kind === 'machine' ? { machineId: 'synthetic-machine' } : {}),
                signer,
              });
              const result = yield* actor.execute(consent);
              expect(result.outcome).toBe('Committed');
              yield* actor.acknowledge(result);
            }
            const input = {
              view: (yield* actor.current()).view,
              authenticatedCredential: { device: recovery.publicKey, genesis: f.anchor },
              requestGenesis: f.anchor,
              stream: 'control',
              method: 'GET',
            };
            expect(ok(authorizeLabStream(input))).toBeUndefined();
            for (const streamName of ['control', 'keys', 'loro', 'flock']) {
              expect(
                Result.isFailure(
                  authorizeLabStream({
                    ...input,
                    stream: streamName,
                    method: 'POST',
                    sub: 'append-cas',
                  })
                )
              ).toBe(true);
            }
            expect(
              Result.isFailure(
                authorizeLabStream({ ...input, stream: 'loro', method: 'PUT', sub: 'snapshot' })
              )
            ).toBe(true);
            assertDenied(
              authorizeLabStream({
                ...input,
                authenticatedCredential: { device: machine.publicKey, genesis: f.anchor },
                stream: 'loro',
                method: 'POST',
              }),
              'method-not-allowed'
            );
            const personal = syntheticSigner(97);
            const consent = yield* prepareDeviceAdmission({
              genesis: f.anchor,
              membershipId: f.membership,
              encryptionPublicKey: ok(Bytes.encryptionPublicKey(new Uint8Array(32).fill(98))),
              kind: 'personal',
              signer: personal,
            });
            const record = yield* signLedgerRecord(
              ok(prepareLedgerCommand(input.view, recovery.publicKey, consent)),
              recovery
            );
            const control = { ...input, stream: 'control', method: 'POST', sub: 'append-cas' };
            expect(ok(authorizeLabStream({ ...control, controlRecord: record }))).toBeUndefined();
            // Screening checks the candidate's signer and personal-device kind.
            // Only the public submission consumer verifies signatures and bound PoP.
            for (const kind of [1, 2])
              assertDenied(
                authorizeLabStream({
                  ...control,
                  controlRecord: ok(
                    encodeCbor([
                      [
                        input.view.head.toBytes(),
                        recovery.publicKey.toBytes(),
                        [
                          4,
                          kind,
                          personal.publicKey.toBytes(),
                          consent.encryptionPublicKey.toBytes(),
                          consent.possessionSignature.toBytes(),
                        ],
                      ],
                      new Uint8Array(64),
                    ])
                  ),
                }),
                'unauthorized'
              );
            const otherSignerRecord = yield* signLedgerRecord(
              ok(prepareLedgerCommand(input.view, f.owner.publicKey, consent)),
              f.owner
            );
            assertDenied(
              authorizeLabStream({ ...control, controlRecord: otherSignerRecord }),
              'unauthorized'
            );
            const gateway = yield* makeLabControlGateway({
              genesis: f.anchor,
              stream,
              checkpoint: () =>
                Effect.sync(() => ({
                  head: hashRecordBytes(originals.at(-1)!),
                  length: originals.length,
                })),
              now: () => 0,
              budget: { maxRecords: 100, maxBytes: 1024 * 1024 },
            });
            const bad = new Uint8Array(record);
            bad[bad.length - 1] = bad[bad.length - 1]! ^ 1;
            const personalRequest = {
              authenticatedCredential: control.authenticatedCredential,
              requestGenesis: f.anchor,
              record,
            };
            const before = originals.map((bytes) => new Uint8Array(bytes));
            expect(
              Result.isFailure(
                yield* Effect.result(gateway.append({ ...personalRequest, record: bad }))
              )
            ).toBe(true);
            expect(originals).toEqual(before);
            yield* gateway.append(personalRequest);
            const current = yield* actor.refresh();
            expect(
              current.view
                .inspectState()
                .devices.get(Buffer.from(personal.publicKey.toBytes()).toString('hex'))
                ?.membershipId.equals(f.membership)
            ).toBe(true);
            const guest = syntheticSigner(92);
            const request = yield* prepareJoinRequest({
              genesis: f.anchor,
              requestId: ok(Bytes.requestId(new Uint8Array(16).fill(93))),
              userId: ok(Bytes.userId(new Uint8Array(32).fill(94))),
              encryptionPublicKey: ok(Bytes.encryptionPublicKey(new Uint8Array(32).fill(95))),
              expiresAt: null,
              signer: guest,
            });
            const guestMembership = ok(Bytes.membershipId(new Uint8Array(16).fill(96)));
            const joined = yield* actor.execute({
              _tag: 'AdmitMember',
              membershipId: guestMembership,
              request,
            });
            expect(joined.outcome).toBe('Committed');
            yield* actor.acknowledge(joined);
            const setRole = yield* actor.execute({
              _tag: 'SetRole',
              membershipId: guestMembership,
              role: 'guest',
            });
            expect(setRole.outcome).toBe('Committed');
            yield* actor.acknowledge(setRole);
            const guestInput = {
              ...input,
              view: (yield* actor.current()).view,
              authenticatedCredential: { device: guest.publicKey, genesis: f.anchor },
            };
            expect(ok(authorizeLabStream(guestInput))).toBeUndefined();
            assertDenied(
              authorizeLabStream({
                ...guestInput,
                stream: 'keys',
                method: 'POST',
                sub: 'append-cas',
              }),
              'unknown-stream',
              404
            );
            expect(
              Result.isFailure(
                authorizeLabStream({ ...guestInput, stream: 'loro', method: 'POST' })
              )
            ).toBe(true);
            const replacement = syntheticSigner(150);
            const machineConsent = yield* prepareDeviceAdmission({
              genesis: f.anchor,
              membershipId: f.membership,
              encryptionPublicKey: ok(Bytes.encryptionPublicKey(new Uint8Array(32).fill(151))),
              kind: 'machine',
              machineId: 'synthetic-machine',
              signer: replacement,
            });
            expect((yield* actor.current()).view.inspectState().epoch.rotationRequired).toBe(false);
            const replaced = yield* actor.execute({
              ...machineConsent,
              replaces: machine.publicKey,
            });
            expect(replaced.outcome).toBe('Committed');
            yield* actor.acknowledge(replaced);
            const replacementView = (yield* actor.current()).view;
            expect(
              replacementView
                .inspectState()
                .devices.has(Buffer.from(machine.publicKey.toBytes()).toString('hex'))
            ).toBe(false);
            expect(
              replacementView
                .inspectState()
                .devices.get(Buffer.from(replacement.publicKey.toBytes()).toString('hex'))
                ?.machineId
            ).toBe('synthetic-machine');
            expect(replacementView.inspectState().epoch.rotationRequired).toBe(true);
            const revoked = yield* actor.execute({
              _tag: 'RevokeDevice',
              target: recovery.publicKey,
            });
            expect(revoked.outcome).toBe('Committed');
            yield* actor.acknowledge(revoked);
            const removed = (yield* actor.current()).view;
            expect(ok(authorizeLabStream({ ...input, view: removed }))).toBeUndefined();
            for (const deniedStream of ['loro', 'flock'])
              assertDenied(
                authorizeLabStream({ ...input, view: removed, stream: deniedStream }),
                'unauthorized'
              );
            assertDenied(
              authorizeLabStream({ ...input, view: removed, method: 'POST', sub: 'append-cas' }),
              'unauthorized'
            );
            assertDenied(
              authorizeLabStream({
                ...input,
                view: removed,
                authenticatedCredential: { ...input.authenticatedCredential, genesis: null },
              }),
              'unauthorized'
            );
          })
        )
      );
    } finally {
      await f.close();
    }
  });
});

describe('public submission consumer behind the Lab control gateway', () => {
  it('verifies the whole selected prefix, binds signer/Org and uses real SDK pinned CAS; failed candidates preserve the actual remote tail', async () => {
    const f = await fixture();
    try {
      const originals = [...f.records];
      const stream: LedgerSubmissionStream = {
        read: f.sdk.read.bind(f.sdk),
        appendCas: async (input) => {
          const result = await f.sdk.appendCas(input);
          if (result.ok && result.result.kind === 'ok')
            originals.push(new Uint8Array(input.part.body.subarray(4)));
          return result;
        },
      };
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const gateway = yield* makeLabControlGateway({
              genesis: f.anchor,
              stream,
              checkpoint: () =>
                Effect.sync(() => ({
                  head: hashRecordBytes(originals.at(-1)!),
                  length: originals.length,
                })),
              now: () => 0,
              budget: { maxRecords: 100, maxBytes: 1024 * 1024 },
            });
            const extra = syntheticSigner(107);
            const command = yield* prepareDeviceAdmission({
              genesis: f.anchor,
              membershipId: f.membership,
              encryptionPublicKey: ok(Bytes.encryptionPublicKey(new Uint8Array(32).fill(108))),
              kind: 'personal',
              signer: extra,
            });
            const original = yield* signLedgerRecord(
              ok(prepareLedgerCommand(f.view, f.owner.publicKey, command)),
              f.owner
            );
            const request = {
              authenticatedCredential: { device: f.owner.publicKey, genesis: f.anchor },
              requestGenesis: f.anchor,
              record: original,
            };
            const bad = new Uint8Array(original);
            bad[bad.length - 1] = bad[bad.length - 1]! ^ 1;
            expect(
              Result.isFailure(yield* Effect.result(gateway.append({ ...request, record: bad })))
            ).toBe(true);
            expect(
              Result.isFailure(
                yield* Effect.result(
                  gateway.append({
                    ...request,
                    authenticatedCredential: { device: extra.publicKey, genesis: f.anchor },
                  })
                )
              )
            ).toBe(true);
            expect(
              Result.isFailure(
                yield* Effect.result(
                  gateway.append({
                    ...request,
                    requestGenesis: ok(Bytes.genesisHash(new Uint8Array(32).fill(109))),
                  })
                )
              )
            ).toBe(true);
            const reader = yield* makeLedgerStreamReader(f.sdk);
            expect((yield* reader.readAfter('-1')).records).toEqual(f.records);
            const result = yield* gateway.append(request);
            const after = yield* reader.readAfter('-1');
            expect(after.records).toEqual([...f.records, original]);
            expect(after.nextOffset).toBe(result.nextOffset);
            expect(Result.isFailure(yield* Effect.result(gateway.append(request)))).toBe(true);
            expect((yield* reader.readAfter('-1')).records).toEqual(after.records);
          })
        )
      );
    } finally {
      await f.close();
    }
  });
});

it('stops gateway admission, interrupts and awaits its actual SDK CAS operation before closing the earlier Riverrun owner', async () => {
  const f = await fixture();
  const latch = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  const entered = latch(),
    release = latch();
  let rawSettled = false,
    closedEarly = false,
    closed = false;
  let gateway: Effect.Success<ReturnType<typeof makeLabControlGateway>>;
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const child = yield* Scope.make();
          yield* Scope.addFinalizer(
            child,
            Effect.promise(async () => {
              closedEarly = !rawSettled;
              await f.close();
              closed = true;
            })
          );
          const command = yield* prepareDeviceAdmission({
            genesis: f.anchor,
            membershipId: f.membership,
            encryptionPublicKey: ok(Bytes.encryptionPublicKey(new Uint8Array(32).fill(111))),
            kind: 'personal',
            signer: syntheticSigner(110),
          });
          const record = yield* signLedgerRecord(
            ok(prepareLedgerCommand(f.view, f.owner.publicKey, command)),
            f.owner
          );
          gateway = yield* makeLabControlGateway({
            genesis: f.anchor,
            budget: { maxRecords: 100, maxBytes: 1024 * 1024 },
            now: () => 0,
            checkpoint: () => Effect.succeed(f.checkpoint),
            stream: {
              read: f.sdk.read.bind(f.sdk),
              appendCas: async (request) => {
                entered.resolve();
                await release.promise;
                try {
                  return await f.sdk.appendCas(request);
                } finally {
                  rawSettled = true;
                }
              },
            },
          }).pipe(Effect.provideService(Scope.Scope, child));
          const request = {
            authenticatedCredential: { device: f.owner.publicKey, genesis: f.anchor },
            requestGenesis: f.anchor,
            record,
          };
          const worker = yield* Effect.forkChild(Effect.result(gateway.append(request)));
          yield* Effect.addFinalizer(() => Effect.sync(release.resolve));
          yield* Effect.promise(() => entered.promise);
          const closing = yield* Effect.forkChild(Scope.close(child, Exit.void), {
            startImmediately: true,
          });
          // Observe close through a separate current-admission probe, not microtask counts.
          const denied = yield* Effect.result(gateway.append(request));
          expect(Result.isFailure(denied)).toBe(true);
          const pending = closing.pollUnsafe();
          release.resolve();
          yield* Fiber.join(closing);
          expect(closedEarly).toBe(false);
          expect(closed).toBe(true);
          expect(rawSettled).toBe(true);
          expect(pending).toBeUndefined();
          expect(Result.isFailure(yield* Fiber.join(worker))).toBe(true);
        })
      )
    );
  } finally {
    release.resolve();
    if (!closed) await f.close();
  }
});

import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { Effect, Result } from 'effect';
import { Bytes, sealPresenceContent } from '@lody/e2ee-core/protocol';
import { makePresenceContentBinding } from '@lody/e2ee-core/adapters/loro-streams';
import {
  copyEpochKeyBytes,
  disposeEpochKey,
} from '../../e2ee-core/src/internal/foundation/epoch-key';
import { envelopeFixture } from '../../e2ee-core/test/keys/fixture';
import { makeEncryptedPresence } from '../src/encrypted-presence';
import { encodeE2eePresenceBody } from '../src/e2ee-wire';
import {
  isFreshLodyPresenceState,
  type LodyPresenceState,
  type MachineId,
  type LodyPresenceInstanceId,
} from '@lody/shared';

const key = 'machine:fixture-machine:instance';
const machine = (time = 1000): LodyPresenceState => ({
  kind: 'machine',
  machineId: 'fixture-machine' as MachineId,
  instanceId: 'instance' as LodyPresenceInstanceId,
  updatedAt: time,
});
function fixture(kind: 0 | 1 | 2 = 1) {
  const f = envelopeFixture(kind);
  const keyBytes = copyEpochKeyBytes(f.secret);
  let now = 1000;
  const input = {
    workspaceId: 'workspace',
    genesis: f.view().genesis,
    signer: f.phone.signer,
    ledger: f.ledger,
    readEpochKey: () => Effect.sync(() => Result.getOrThrow(Bytes.epochKey(keyBytes))),
    now: () => now,
    incarnation: new Uint8Array(16).fill(1),
  };
  return {
    f,
    input,
    setNow: (time: number) => {
      now = time;
    },
    make: (overrides: Partial<typeof input> = {}) =>
      makeEncryptedPresence({ ...input, ...overrides }),
  };
}
const run = (test: () => Effect.fn.Return<void, unknown, import('effect').Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(Effect.gen(test)));

describe('encrypted presence admission', () => {
  it('authenticates real member devices, hides body bytes and drops duplicate/out-of-order frames', () =>
    run(function* () {
      const f = fixture();
      const sender = yield* f.make(),
        receiver = yield* f.make();
      const frame = yield* sender.seal({ key, state: machine() }, 0);
      expect(new TextDecoder().decode(frame)).not.toContain('fixture-machine');
      const accepted = yield* receiver.open(frame);
      expect(accepted?.state).toEqual(machine());
      expect(accepted?.expiresAt).toBe(61000);
      expect(yield* receiver.open(frame)).toBeNull();
      const next = yield* sender.seal({ key, state: machine() }, 0);
      const last = yield* sender.seal({ key, state: null }, 0);
      expect((yield* receiver.open(last))?.state).toBeNull();
      expect(yield* receiver.open(next)).toBeNull();
    }));
  it('expires at the exact 60-second boundary, including the existing 90-second UI readers', () =>
    run(function* () {
      const f = fixture();
      const sender = yield* f.make();
      const frame = yield* sender.seal({ key, state: machine() }, 0);
      f.setNow(60999);
      const accepted = yield* (yield* f.make()).open(frame);
      expect(accepted?.state).toEqual(machine());
      expect(
        isFreshLodyPresenceState({ ...machine(), expiresAt: accepted!.expiresAt }, 60999)
      ).toBe(true);
      expect(
        isFreshLodyPresenceState({ ...machine(), expiresAt: accepted!.expiresAt }, 61000)
      ).toBe(false);
      f.setNow(61000);
      expect(yield* (yield* f.make()).open(frame)).toBeNull();
    }));
  it('rejects cross-workspace, cross-room, cross-genesis, forged signature, and malformed input independently', () =>
    run(function* () {
      const f = fixture();
      const sender = yield* f.make(),
        receiver = yield* f.make();
      const frame = yield* sender.seal({ key, state: machine() }, 0);
      expect(yield* (yield* f.make({ workspaceId: 'other' })).open(frame)).toBeNull();
      const foreign = envelopeFixture(1, 101);
      expect(
        yield* (yield* f.make({ genesis: foreign.view().genesis, ledger: foreign.ledger })).open(
          frame
        )
      ).toBeNull();
      const room = yield* makePresenceContentBinding({ ...f.input, resource: 'other-room' });
      expect(yield* receiver.open(yield* room.seal(new Uint8Array([1]), 0))).toBeNull();
      const damaged = frame.slice();
      damaged[damaged.length - 1]! ^= 1;
      for (const bad of [damaged, new Uint8Array([0]), new Uint8Array(66000)])
        expect(yield* receiver.open(bad)).toBeNull();
      expect((yield* receiver.open(frame))?.state).toEqual(machine());
    }));
  it('rejects future issue times without consuming replay state', () =>
    run(function* () {
      const f = fixture();
      const sender = yield* f.make(),
        receiver = yield* f.make();
      const frame = yield* sender.seal({ key, state: machine() }, 0);
      f.setNow(999);
      expect(yield* receiver.open(frame)).toBeNull();
      f.setNow(1000);
      expect((yield* receiver.open(frame))?.state).toEqual(machine());
    }));
  it('does not resurrect a retired sender incarnation', () =>
    run(function* () {
      const f = fixture();
      const old = yield* f.make(),
        receiver = yield* f.make();
      const stale = yield* old.seal({ key, state: machine() }, 0);
      f.setNow(1001);
      const current = yield* f.make({ incarnation: new Uint8Array(16).fill(2) });
      const clear = yield* current.seal({ key, state: null }, 0);
      expect((yield* receiver.open(clear))?.state).toBeNull();
      expect(yield* receiver.open(stale)).toBeNull();
    }));
  it('rejects revoked and never-admitted devices even if they possess the epoch key', () =>
    run(function* () {
      const f = fixture();
      const sender = yield* f.make(),
        receiver = yield* f.make();
      const frame = yield* sender.seal({ key, state: machine() }, 0);
      f.f.append([5, f.f.phone.raw]);
      expect(yield* receiver.open(frame)).toBeNull();
      expect(
        Result.isFailure(yield* Effect.result(sender.seal({ key, state: machine() }, 0)))
      ).toBe(true);
      const privateKey = createPrivateKey({
        key: Buffer.concat([
          Buffer.from('302e020100300506032b657004220420', 'hex'),
          Buffer.alloc(32, 99),
        ]),
        format: 'der',
        type: 'pkcs8',
      });
      const publicKey = Result.getOrThrow(
        Bytes.signingPublicKey(
          new Uint8Array(
            createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32)
          )
        )
      );
      const epochKey = yield* f.input.readEpochKey();
      const foreignFrame = yield* sealPresenceContent({
        scope: {
          genesis: Buffer.from(f.input.genesis.toBytes()).toString('hex'),
          resource: 'presence:workspace',
          epoch: 0,
        },
        epochKey,
        signer: {
          publicKey,
          sign: (message) =>
            Effect.sync(() =>
              Result.getOrThrow(Bytes.signature(new Uint8Array(sign(null, message, privateKey))))
            ),
        },
        plaintext: new Uint8Array([1]),
      });
      disposeEpochKey(epochKey);
      expect(yield* receiver.open(foreignFrame)).toBeNull();
    }));
  it('checks membership again after asynchronous signing', () =>
    run(function* () {
      const f = fixture();
      const signer = {
        publicKey: f.f.phone.publicKey,
        sign: (bytes: Uint8Array) =>
          Effect.gen(function* () {
            const signature = yield* f.f.phone.signer.sign(bytes);
            f.f.append([5, f.f.phone.raw]);
            return signature;
          }),
      };
      const sender = yield* f.make({ signer });
      expect(
        Result.isFailure(yield* Effect.result(sender.seal({ key, state: machine() }, 0)))
      ).toBe(true);
    }));
  it.each([0, 2] as const)('rejects machine identity claims from device kind %s', (kind) =>
    run(function* () {
      const f = fixture(kind);
      const sender = yield* f.make();
      expect(
        Result.isFailure(yield* Effect.result(sender.seal({ key, state: machine() }, 0)))
      ).toBe(true);
    })
  );
  it('rejects a member machine claiming another machine or a noncanonical state key', () =>
    run(function* () {
      const f = fixture();
      const sender = yield* f.make();
      for (const publication of [
        { key, state: { ...machine(), machineId: 'other' } },
        { key: 'session:x:y', state: machine() },
      ])
        expect(Result.isFailure(yield* Effect.result(sender.seal(publication, 0)))).toBe(true);
    }));
  it('rejects signed invalid body/schema/oversized liveness while a following valid frame succeeds', () =>
    run(function* () {
      const f = fixture();
      const sender = yield* f.make(),
        receiver = yield* f.make();
      const raw = yield* makePresenceContentBinding({ ...f.input, resource: 'presence:workspace' });
      for (const payload of [
        new Uint8Array([255]),
        new TextEncoder().encode(
          JSON.stringify({ key, state: { ...machine(), machineId: 'other' } })
        ),
        new Uint8Array(4097),
      ]) {
        const body = encodeE2eePresenceBody({
          incarnation: f.input.incarnation,
          sequence: 500,
          issuedAt: 1000,
          expiresAt: 61000,
          payload,
        });
        expect(yield* receiver.open(yield* raw.seal(body, 0))).toBeNull();
      }
      expect(
        (yield* receiver.open(yield* sender.seal({ key, state: machine() }, 0)))?.state
      ).toEqual(machine());
    }));
  it('retains session phases and clears as disposable signed state', () =>
    run(function* () {
      const f = fixture();
      const sender = yield* f.make(),
        receiver = yield* f.make();
      for (const status of [
        { type: 'running', phase: 'finalizing' },
        { type: 'requestPermission' },
        { type: 'initializing', stage: 'acp', detail: 'Starting' },
      ] as const) {
        const state = {
          kind: 'session',
          sessionId: 's',
          machineId: 'fixture-machine',
          instanceId: 'instance',
          status,
          updatedAt: 1000,
        };
        expect(
          (yield* receiver.open(yield* sender.seal({ key: 'session:s:instance', state }, 0)))?.state
        ).toEqual(state);
      }
      expect(
        (yield* receiver.open(yield* sender.seal({ key: 'session:s:instance', state: null }, 0)))
          ?.state
      ).toBeNull();
    }));
});

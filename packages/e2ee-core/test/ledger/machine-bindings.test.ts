import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Deferred, Effect, Fiber, Result } from 'effect';
import * as Protocol from '@lody/e2ee-core/protocol';
import {
  encodeCbor,
  decodeRetainedCbor,
  decodeSnapshotCbor,
  encodeSnapshotCbor,
  encodeRetainedCbor,
  type CborValue,
} from '../../src/internal/foundation/cbor';
import { decodeMachineId, encodeMachineId } from '../../src/internal/ledger/machine-id';
import * as Bytes from '../../src/internal/foundation/bytes';
import { keyId } from '../../src/internal/foundation/identifiers';
import {
  applyOperation,
  cloneState,
  genesisState,
  inspectState,
  stateGet,
  type InternalState,
} from '../../src/internal/ledger/policy';
import { decodeRecord, hashRecordBytes, type Operation } from '../../src/internal/ledger/records';
import vector from '../ledger-v1-vector.json';

const ok = Result.getOrThrow;
const bytes = (n: number, length = 32) => new Uint8Array(length).fill(n);
const id = (key: { toBytes(): Uint8Array }) => keyId(key.toBytes());
function device(n: number) {
  const secret = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), bytes(n)]),
    format: 'der',
    type: 'pkcs8',
  });
  return {
    signingPublicKey: ok(
      Bytes.signingPublicKey(
        new Uint8Array(
          createPublicKey(secret).export({ format: 'der', type: 'spki' }).subarray(-32)
        )
      )
    ),
    encryptionPublicKey: ok(Bytes.encryptionPublicKey(bytes(n + 100))),
    signBytes: (message: Uint8Array) => new Uint8Array(sign(null, message, secret)),
  };
}
const oldMachine = device(40),
  replacement = device(41),
  otherMachine = device(42);
const admit = (
  target: ReturnType<typeof device>,
  machineId: string,
  replaces: Bytes.SigningPublicKey | null = null
): Operation => ({
  type: 'admitDevice',
  kind: 'machine',
  ...target,
  machineId,
  replaces,
  // This suite exercises the policy boundary after replay's signature/proof checks.
  possessionSignature: ok(Bytes.signature(bytes(0, 64))),
});

describe('signed machine bindings and current-only state', () => {
  const owner = device(1);
  const domain = (name: string, payload: Uint8Array) =>
    new Uint8Array(Buffer.concat([Buffer.from(`lody-e2ee/${name}\0`), payload]));
  const signed = (body: readonly CborValue[]) => {
    const payload = ok(encodeCbor(body));
    return ok(encodeCbor([body, owner.signBytes(domain('sig/v1', payload))]));
  };
  const initial = () => {
    const record = new Uint8Array(Buffer.from(vector.records[0].hex, 'hex'));
    const head = hashRecordBytes(record);
    return ok(
      Protocol.verifyLedger({
        anchor: ok(Bytes.genesisHash(head.toBytes())),
        records: [record],
        checkpoint: { head, length: 1 },
      })
    );
  };
  const record = (
    view: Protocol.LedgerView,
    target: ReturnType<typeof device>,
    machine: Uint8Array,
    options: {
      proofMachine?: Uint8Array;
      proofGenesis?: Bytes.GenesisHash;
      replaces?: Bytes.SigningPublicKey | null;
    } = {}
  ) => {
    const proof = target.signBytes(
      domain(
        'possess/v2',
        ok(
          encodeCbor([
            (options.proofGenesis ?? view.genesis).toBytes(),
            view.inspectState().owner.toBytes(),
            target.signingPublicKey.toBytes(),
            target.encryptionPublicKey.toBytes(),
            1,
            options.proofMachine ?? machine,
          ])
        )
      )
    );
    return signed([
      view.head.toBytes(),
      owner.signingPublicKey.toBytes(),
      [
        4,
        1,
        target.signingPublicKey.toBytes(),
        target.encryptionPublicKey.toBytes(),
        proof,
        machine,
        options.replaces?.toBytes() ?? null,
      ],
    ]);
  };
  const extend = (view: Protocol.LedgerView, original: Uint8Array) =>
    Protocol.extendLedger(view, [original], {
      head: hashRecordBytes(original),
      length: view.length + 1,
    });
  const snapshot = (view: Protocol.LedgerView) => {
    const proposal = ok(Protocol.prepareLedgerSnapshot(view, owner.signingPublicKey));
    return ok(
      Protocol.verifyLedgerSnapshot({
        snapshot: ok(
          Protocol.encodeSignedSnapshot(
            proposal.bodyBytes,
            ok(Bytes.signature(owner.signBytes(proposal.signingBytes)))
          )
        ),
        trust: {
          source: 'external-confirmation',
          genesis: view.genesis,
          head: view.head,
          length: view.length,
          endorser: owner.signingPublicKey,
          membershipId: view.inspectState().owner,
          kind: 'personal',
          role: 'owner',
          headSignature: ok(Bytes.signature(owner.signBytes(proposal.headAttestationSigningBytes))),
        },
      })
    );
  };

  it('keeps UTF-8 bytes exact without normalization, BOM stripping or surrogate repair', () => {
    for (const text of ['a'.repeat(256), 'é'.repeat(128), 'é', 'e\u0301', '\ufeffmachine', '\0']) {
      const raw = ok(encodeMachineId(text));
      expect(ok(decodeMachineId(raw))).toBe(text);
      expect(raw).toEqual(new TextEncoder().encode(text));
    }
    expect(ok(encodeMachineId('é'))).not.toEqual(ok(encodeMachineId('e\u0301')));
    for (const input of ['', 'a'.repeat(257), 'é'.repeat(129), '\ud800', '\udfff'])
      expect(Result.isFailure(encodeMachineId(input))).toBe(true);
    for (const raw of [
      new Uint8Array(),
      bytes(1, 257),
      Uint8Array.of(0xc0, 0xaf),
      Uint8Array.of(0xed, 0xa0, 0x80),
      Uint8Array.of(0xff),
    ])
      expect(Result.isFailure(decodeMachineId(raw))).toBe(true);
  });

  it('verifies the machine proof against the record ID and workspace before advancing state', () => {
    const before = initial(),
      machine = ok(encodeMachineId('machine-a'));
    for (const original of [
      record(before, oldMachine, machine, { proofMachine: ok(encodeMachineId('machine-b')) }),
      record(before, oldMachine, machine, { proofGenesis: ok(Bytes.genesisHash(bytes(99))) }),
    ]) {
      const failed = extend(before, original);
      expect(Result.isFailure(failed) && failed.failure.code).toBe('bad-proof');
      expect(before.length).toBe(1);
      expect(before.inspectState().devices.size).toBe(1);
    }
    expect(
      ok(extend(before, record(before, oldMachine, machine)))
        .inspectState()
        .devices.get(id(oldMachine.signingPublicKey))?.machineId
    ).toBe('machine-a');
  });

  it('rejects old five-field machine records, malformed IDs and unsigned extra fields on personal devices', () => {
    const before = initial(),
      original = record(before, oldMachine, ok(encodeMachineId('machine')));
    const parsed = ok(decodeRecord(original)).body;
    if (parsed.type !== 'ordinary' || parsed.operation.type !== 'admitDevice')
      throw new Error('fixture');
    const common = [
      4,
      1,
      oldMachine.signingPublicKey.toBytes(),
      oldMachine.encryptionPublicKey.toBytes(),
      parsed.operation.possessionSignature.toBytes(),
    ];
    for (const op of [
      common,
      [...common, new Uint8Array(), null],
      [...common, Uint8Array.of(0xff), null],
      [4, 0, ...common.slice(2), ok(encodeMachineId('machine')), null],
    ])
      expect(
        Result.isFailure(
          extend(before, signed([before.head.toBytes(), owner.signingPublicKey.toBytes(), op]))
        )
      ).toBe(true);
  });

  it('restores exact machine bindings in snapshots and retained state, then replaces atomically with a seal barrier', () => {
    const base = initial(),
      machine = ok(encodeMachineId('machine'));
    const admitted = ok(extend(base, record(base, oldMachine, machine)));
    const retained = ok(Protocol.exportVerifiedState(admitted));
    const sources = [admitted, snapshot(admitted), ok(Protocol.restoreVerifiedState(retained))];
    const original = record(admitted, replacement, machine, {
      replaces: oldMachine.signingPublicKey,
    });
    for (const source of sources) {
      expect(source.inspectState().devices.get(id(oldMachine.signingPublicKey))?.machineId).toBe(
        'machine'
      );
      expect(Result.isFailure(extend(source, record(source, otherMachine, machine)))).toBe(true);
      const replaced = ok(extend(source, original));
      expect(replaced.inspectState().devices.has(id(oldMachine.signingPublicKey))).toBe(false);
      expect(replaced.inspectState().devices.get(id(replacement.signingPublicKey))?.machineId).toBe(
        'machine'
      );
      expect(
        ok(Protocol.contentPermissions(replaced, replacement.signingPublicKey)).maySealNewContent
      ).toBe(false);
      expect(
        ok(Protocol.contentPermissions(replaced, oldMachine.signingPublicKey)).mayWriteDocument
      ).toBe(false);
      expect(
        Result.isSuccess(Protocol.historicalContentIdentity(replaced, oldMachine.signingPublicKey))
      ).toBe(true);
      const reopened = ok(
        Protocol.restoreVerifiedState(ok(Protocol.exportVerifiedState(replaced)))
      );
      expect(ok(Protocol.ledgerStateDigest(reopened)).toBytes()).toEqual(
        ok(Protocol.ledgerStateDigest(replaced)).toBytes()
      );
      expect(reopened.inspectState().epoch.rotationRequired).toBe(true);
    }
  });

  it('rejects corrupted retained machine bindings without changing the earlier verified view', () => {
    const base = initial(),
      view = ok(extend(base, record(base, oldMachine, ok(encodeMachineId('machine')))));
    const saved = ok(Protocol.exportVerifiedState(view));
    for (const edit of ['missing', 'invalid-utf8', 'wrong-index'] as const) {
      const root = ok(decodeRetainedCbor(saved.bytes)) as CborValue[],
        state = root[4] as CborValue[];
      const bindings = new Uint8Array(state[6] as Uint8Array);
      if (edit === 'missing') state[6] = new Uint8Array();
      else if (edit === 'invalid-utf8') {
        bindings[6] = 0xff;
        state[6] = bindings;
      } else {
        bindings.set(bytes(255, 4), 0);
        state[6] = bindings;
      }
      expect(
        Result.isFailure(
          Protocol.restoreVerifiedState({
            ...saved,
            stateDigest: undefined,
            bytes: ok(encodeRetainedCbor(root)),
          })
        )
      ).toBe(true);
      expect(view.length).toBe(2);
    }
  });

  it('rejects invalid producer strings before signing any machine proof', async () => {
    const before = initial();
    let signedCount = 0;
    for (const machineId of ['', 'x'.repeat(257), '\ud800']) {
      const outcome = await Effect.runPromise(
        Effect.result(
          Protocol.prepareDeviceAdmission({
            genesis: before.genesis,
            membershipId: before.inspectState().owner,
            encryptionPublicKey: oldMachine.encryptionPublicKey,
            kind: 'machine',
            machineId,
            signer: {
              publicKey: oldMachine.signingPublicKey,
              sign: (message) =>
                Effect.sync(() => {
                  signedCount++;
                  return ok(Bytes.signature(oldMachine.signBytes(message)));
                }),
            },
          })
        )
      );
      expect(Result.isFailure(outcome)).toBe(true);
    }
    expect(signedCount).toBe(0);
  });
  it('captures machine identity before a borrowed signer waits', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const before = initial(),
            entered = yield* Deferred.make<void>(),
            release = yield* Deferred.make<void>();
          const input = {
            genesis: before.genesis,
            membershipId: before.inspectState().owner,
            encryptionPublicKey: oldMachine.encryptionPublicKey,
            kind: 'machine' as const,
            machineId: 'original-machine',
            signer: {
              publicKey: oldMachine.signingPublicKey,
              sign: (message: Uint8Array) =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(release);
                  return ok(Bytes.signature(oldMachine.signBytes(message)));
                }),
            },
          };
          const fiber = yield* Effect.forkChild(Protocol.prepareDeviceAdmission(input));
          yield* Deferred.await(entered);
          input.machineId = 'substituted-machine';
          yield* Deferred.succeed(release, undefined);
          const original = yield* Fiber.join(fiber);
          expect(original.machineId).toBe('original-machine');
          expect(
            Result.isSuccess(
              Protocol.prepareLedgerCommand(before, owner.signingPublicKey, original)
            )
          ).toBe(true);
        })
      )
    );
  });
  it('rejects duplicate active machine bindings in a qualified snapshot and own retained state', () => {
    const base = initial();
    const first = ok(extend(base, record(base, oldMachine, ok(encodeMachineId('machine-a')))));
    const view = ok(extend(first, record(first, otherMachine, ok(encodeMachineId('machine-b')))));
    const change = (state: CborValue[]) => {
      const table = new Uint8Array(state[6] as Uint8Array);
      const width = 6 + 'machine-a'.length;
      table.set(new TextEncoder().encode('machine-a'), 6);
      table.set(new TextEncoder().encode('machine-a'), width + 6);
      state[6] = table;
    };
    const retained = ok(Protocol.exportVerifiedState(view)),
      root = ok(decodeRetainedCbor(retained.bytes)) as CborValue[];
    change(root[4] as CborValue[]);
    expect(
      Result.isFailure(
        Protocol.restoreVerifiedState({
          ...retained,
          stateDigest: undefined,
          bytes: ok(encodeRetainedCbor(root)),
        })
      )
    ).toBe(true);
    const proposal = ok(Protocol.prepareLedgerSnapshot(view, owner.signingPublicKey));
    const body = ok(decodeSnapshotCbor(proposal.bodyBytes)) as CborValue[];
    change(body[5] as CborValue[]);
    const changed = ok(encodeSnapshotCbor(body));
    expect(
      Result.isFailure(
        Protocol.verifyLedgerSnapshot({
          snapshot: ok(
            Protocol.encodeSignedSnapshot(
              changed,
              ok(Bytes.signature(owner.signBytes(Protocol.snapshotSigningBytes(changed))))
            )
          ),
          trust: {
            source: 'external-confirmation',
            genesis: view.genesis,
            head: view.head,
            length: view.length,
            endorser: owner.signingPublicKey,
            membershipId: view.inspectState().owner,
            kind: 'personal',
            role: 'owner',
            headSignature: ok(
              Bytes.signature(owner.signBytes(proposal.headAttestationSigningBytes))
            ),
          },
        })
      )
    ).toBe(true);
    expect(view.inspectState().devices.size).toBe(3);
  });
});
function fixture() {
  const records = vector.records.map((record) => new Uint8Array(Buffer.from(record.hex, 'hex')));
  const genesis = ok(decodeRecord(records[0])).body;
  if (genesis.type !== 'genesis') throw new Error('fixture genesis');
  const hash = hashRecordBytes(records[0]);
  const state = genesisState(genesis, ok(Bytes.genesisHash(hash.toBytes())), hash);
  // Admit Bob from the independent frozen vector, preserving the real membership/keys.
  const bobRecord = ok(decodeRecord(records[1])).body;
  if (bobRecord.type !== 'ordinary' || bobRecord.operation.type !== 'admitMember')
    throw new Error('fixture member');
  ok(applyOperation(state, bobRecord));
  const run = (operation: Operation, signer = genesis.signer, target = state) =>
    applyOperation(target, { type: 'ordinary', previousHash: hash, signer, operation });
  return { state, run, owner: genesis.signer, bob: bobRecord.operation.request.signingPublicKey };
}
function evidence(state: InternalState) {
  return {
    ...inspectState(state),
    machines: [...state.machineDevices],
    history: [...state.deviceHistory],
    usedKeys: [...state.usedEncKeys],
  };
}

describe('machine binding authorization transitions (wire encoding independent)', () => {
  it('reserves a machineId across all members and leaves a rejected branch unchanged', () => {
    const f = fixture();
    ok(f.run(admit(oldMachine, 'machine-1')));
    const before = evidence(f.state);
    const branch = cloneState(f.state);
    expect(Result.isFailure(f.run(admit(otherMachine, 'machine-1'), f.bob, branch))).toBe(true);
    expect(evidence(branch)).toEqual(before);
    expect(evidence(f.state)).toEqual(before);
  });

  it('atomically replaces only the exact active key, preserves history and requires rotation', () => {
    const f = fixture();
    ok(f.run(admit(oldMachine, 'machine-1')));
    const original = evidence(f.state),
      branch = cloneState(f.state);
    ok(f.run(admit(replacement, 'machine-1', oldMachine.signingPublicKey), f.owner, branch));
    expect(evidence(f.state)).toEqual(original);
    expect(stateGet(branch.devices, id(oldMachine.signingPublicKey))).toBeUndefined();
    expect(stateGet(branch.devices, id(replacement.signingPublicKey))?.machineId).toBe('machine-1');
    expect(stateGet(branch.deviceHistory, id(oldMachine.signingPublicKey))?.machineId).toBe(
      'machine-1'
    );
    expect(stateGet(branch.machineDevices, 'machine-1')).toBe(id(replacement.signingPublicKey));
    expect(branch.epoch.rotationRequired).toBe(true);
    expect(Result.isFailure(f.run(admit(oldMachine, 'machine-2'), f.owner, branch))).toBe(true);
  });

  it('does not let another member replace a machine, even when that member is Owner', () => {
    const f = fixture();
    ok(f.run(admit(oldMachine, 'machine-1'), f.bob));
    const before = evidence(f.state);
    const result = f.run(admit(replacement, 'machine-1', oldMachine.signingPublicKey));
    expect(Result.isFailure(result) && result.failure.code).toBe('unauthorized');
    expect(evidence(f.state)).toEqual(before);
  });

  it.each(['wrong-id', 'wrong-key', 'retired-key'] as const)(
    'refuses %s replacements before changing either identity',
    (kind) => {
      const f = fixture();
      ok(f.run(admit(oldMachine, 'machine-1')));
      if (kind === 'retired-key')
        ok(f.run({ type: 'revokeDevice', target: oldMachine.signingPublicKey }));
      const before = evidence(f.state);
      expect(
        Result.isFailure(
          f.run(
            admit(
              replacement,
              kind === 'wrong-id' ? 'machine-2' : 'machine-1',
              kind === 'wrong-key' ? otherMachine.signingPublicKey : oldMachine.signingPublicKey
            )
          )
        )
      ).toBe(true);
      expect(evidence(f.state)).toEqual(before);
    }
  );

  it('releases an active binding on revoke while preserving historical key non-reuse', () => {
    const f = fixture();
    ok(f.run(admit(oldMachine, 'machine-1')));
    ok(f.run({ type: 'revokeDevice', target: oldMachine.signingPublicKey }));
    expect(stateGet(f.state.machineDevices, 'machine-1')).toBeUndefined();
    ok(f.run(admit(replacement, 'machine-1')));
    expect(f.state.epoch.rotationRequired).toBe(true);
    expect(stateGet(f.state.deviceHistory, id(oldMachine.signingPublicKey))).toBeDefined();
    expect(Result.isFailure(f.run(admit(oldMachine, 'machine-2')))).toBe(true);
  });

  it('releases removed-member bindings without resurrecting the removed device', () => {
    const f = fixture();
    ok(f.run(admit(oldMachine, 'machine-1'), f.bob));
    const member = stateGet(f.state.devices, id(f.bob))!.membershipId;
    ok(
      f.run({
        type: 'removeMemberAndPublishEpoch',
        membershipId: member,
        epoch: ok(Bytes.epochNumber(1)),
        commitment: ok(Bytes.epochCommitment(bytes(99))),
        previousEpochKey: bytes(9, 72),
      })
    );
    expect(stateGet(f.state.machineDevices, 'machine-1')).toBeUndefined();
    expect(stateGet(f.state.devices, id(oldMachine.signingPublicKey))).toBeUndefined();
    ok(f.run(admit(replacement, 'machine-1')));
    expect(stateGet(f.state.deviceHistory, id(oldMachine.signingPublicKey))).toBeDefined();
  });
});

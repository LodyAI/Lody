import * as EpochKeys from '@lody/e2ee-core/protocol';
import { envelopeFixture } from '../keys/fixture';
import * as Snapshots from '@lody/e2ee-core/protocol';
import {
  decodeRetainedCbor,
  decodeSnapshotCbor,
  encodeRetainedCbor,
  encodeSnapshotCbor,
} from '../../src/internal/foundation/cbor';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LedgerLog, SubmissionJournal, LedgerLogError } from '@lody/e2ee-core/services';
import { submitRecord, resumeSubmission } from '../submission/fixture';
import { sqliteSubmissionJournal } from '@lody/e2ee-core/adapters/node-sqlite';
import * as SubmissionFixture from '../submission/fixture';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Effect, Result, Deferred, Fiber } from 'effect';
import * as Admission from '@lody/e2ee-core/protocol';
import * as Commands from '@lody/e2ee-core/protocol';
import type { DeviceSigner } from '@lody/e2ee-core/protocol';
import * as Bytes from '../../src/internal/foundation/bytes';
import { encodeCbor, type CborValue } from '../../src/internal/foundation/cbor';
import { keyId } from '../../src/internal/foundation/identifiers';
import * as Ledger from '@lody/e2ee-core/protocol';
import ledgerV1 from '../ledger-v1-vector.json';

const ok = <A, E>(r: Result.Result<A, E>): A => Result.getOrThrow(r);
const filled = (n: number, size = 32) => new Uint8Array(size).fill(n);
const id = (n: number) => filled(n, 16);
const hex = (v: { toBytes(): Uint8Array }) => keyId(v.toBytes());
function keys(n: number) {
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), filled(n)]),
    format: 'der',
    type: 'pkcs8',
  });
  const pk = new Uint8Array(
    createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32)
  );
  return {
    pk,
    enc: filled(n + 100),
    sign: (message: Uint8Array) => new Uint8Array(sign(null, message, privateKey)),
  };
}
type Keys = ReturnType<typeof keys>;
const owner = keys(1),
  bob = keys(2),
  carol = keys(3),
  phone = keys(4),
  machine = keys(5),
  recovery = keys(6),
  attacker = keys(7);
function domain(name: string, payload: Uint8Array) {
  return new Uint8Array(Buffer.concat([Buffer.from(`lody-e2ee/${name}\0`), payload]));
}
function signed(body: readonly CborValue[], signer: Keys, signature?: Uint8Array) {
  const bytes = ok(encodeCbor(body));
  return ok(encodeCbor([body, signature ?? signer.sign(domain('sig/v1', bytes))]));
}
function checkpoint(records: Uint8Array[]): Ledger.LedgerCheckpoint {
  return { head: Ledger.hashRecordBytes(records[records.length - 1]!), length: records.length };
}
function org() {
  const genesis = signed([1, owner.pk, filled(10), id(10), owner.enc, filled(20)], owner);
  const anchor = ok(Bytes.genesisHash(Ledger.hashRecordBytes(genesis).toBytes()));
  const records = [genesis];
  const verify = () => Ledger.verifyLedger({ anchor, records, checkpoint: checkpoint(records) });
  const append = (
    signer: Keys,
    op: readonly CborValue[],
    sig?: Uint8Array,
    parent = checkpoint(records).head.toBytes()
  ) => {
    const record = signed([parent, signer.pk, op], signer, sig);
    records.push(record);
    return record;
  };
  const join = (target: Keys, n: number, proofAnchor = anchor) => {
    const body = [id(n), filled(n), target.pk, target.enc, null] as const;
    return [
      1,
      id(n),
      [...body, target.sign(domain('join/v1', ok(encodeCbor([proofAnchor.toBytes(), ...body]))))],
    ] as const;
  };
  const device = (target: Keys, kind: number, membership = id(10), proofAnchor = anchor) => {
    const machineId = new TextEncoder().encode(`machine:${Buffer.from(target.pk).toString('hex')}`);
    const extra = kind === 1 ? [machineId] : [];
    const message = domain(
      'possess/v2',
      ok(encodeCbor([proofAnchor.toBytes(), membership, target.pk, target.enc, kind, ...extra]))
    );
    return [
      4,
      kind,
      target.pk,
      target.enc,
      target.sign(message),
      ...(kind === 1 ? [machineId, null] : []),
    ] as const;
  };
  return { anchor, records, verify, append, join, device };
}
function code<A>(r: Result.Result<A, Ledger.LedgerError>) {
  return Result.isFailure(r) ? r.failure.code : 'accepted';
}
function comparable(view: Ledger.LedgerView) {
  const s = view.inspectState();
  return {
    head: hex(view.head),
    length: view.length,
    owner: hex(s.owner),
    epoch: { ...s.epoch, keyCommitment: hex(s.epoch.keyCommitment) },
    members: [...s.members]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, hex(v.userId), v.role]),
    devices: [...s.devices]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, hex(v.membershipId), v.kind, hex(v.encryptionPublicKey)]),
  };
}

describe('strict records and caller-pinned chain', () => {
  it('keeps persistent verified branches and failed authorization independent', () => {
    const o = org();
    o.append(owner, o.join(bob, 11));
    const base = ok(o.verify()),
      before = comparable(base);
    const branch = (role: number) =>
      signed([base.head.toBytes(), owner.pk, [3, id(11), role]], owner);
    const aBytes = branch(1),
      bBytes = branch(3);
    const a = ok(
      Ledger.extendLedger(base, [aBytes], { head: Ledger.hashRecordBytes(aBytes), length: 3 })
    );
    const b = ok(
      Ledger.extendLedger(base, [bBytes], { head: Ledger.hashRecordBytes(bBytes), length: 3 })
    );
    expect(a.inspectState().members.get(hex(ok(Bytes.membershipId(id(11)))))?.role).toBe('admin');
    expect(b.inspectState().members.get(hex(ok(Bytes.membershipId(id(11)))))?.role).toBe('guest');
    const wrong = signed([base.head.toBytes(), owner.pk, [3, id(11), 2]], owner);
    expect(
      code(
        Ledger.extendLedger(base, [aBytes, wrong], {
          head: Ledger.hashRecordBytes(wrong),
          length: 4,
        })
      )
    ).toBe('wrong-parent');
    expect(comparable(base)).toEqual(before);
    expect(code(Ledger.requireLedgerContinuation(a, b))).toBe('checkpoint-mismatch');
    const detached = a.inspectState().members as Map<string, Ledger.Member>;
    detached.clear();
    expect(a.inspectState().members.size).toBe(2);
    expect(comparable(base)).toEqual(before);
  });

  it('cooperatively audits actual signed history with the same result and failure position', async () => {
    const o = org();
    o.append(owner, o.join(bob, 11));
    for (let index = 0; index < 96; index++) o.append(owner, [3, id(11), index % 2 ? 2 : 1]);
    const input = { anchor: o.anchor, records: o.records, checkpoint: checkpoint(o.records) };
    let turns = 0;
    const view = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pulse = yield* Effect.forever(
            Effect.sync(() => {
              turns++;
            }).pipe(Effect.andThen(Effect.yieldNow))
          ).pipe(Effect.forkChild);
          const verified = yield* Ledger.verifyLedgerEffect(input);
          yield* Fiber.interrupt(pulse);
          return verified;
        })
      )
    );
    expect(turns).toBeGreaterThan(1);
    expect(comparable(view)).toEqual(comparable(ok(o.verify())));
    const bad = o.records.map((row) => new Uint8Array(row));
    bad[50]![bad[50]!.length - 1] ^= 1;
    const expected = Ledger.verifyLedger({ ...input, records: bad });
    const actual = await Effect.runPromise(
      Effect.result(Ledger.verifyLedgerEffect({ ...input, records: bad }))
    );
    expect(Result.isFailure(expected)).toBe(true);
    expect(Result.isFailure(actual)).toBe(true);
    if (Result.isFailure(expected) && Result.isFailure(actual)) {
      expect(actual.failure.code).toBe(expected.failure.code);
      expect(actual.failure.position).toBe(expected.failure.position);
    }
    expect(comparable(view)).toEqual(comparable(ok(o.verify())));
  });

  it('uses unchanged native-signed byte domains and P07-a verifier', () => {
    const o = org();
    const parsed = ok(Ledger.decodeRecord(o.records[0]));
    expect(Ledger.hashRecordBytes(o.records[0]!).toBytes()).toEqual(
      new Uint8Array(createHash('sha256').update(domain('rec/v1', o.records[0]!)).digest())
    );
    expect(Ledger.recordSigningBytes(parsed.bodyBytes)).toEqual(domain('sig/v1', parsed.bodyBytes));
    o.append(owner, o.join(bob, 11));
    const op = ok(Ledger.decodeRecord(o.records[1])).body;
    if (op.type !== 'ordinary' || op.operation.type !== 'admitMember') throw new Error('fixture');
    expect(ok(Ledger.joinRequestSigningBytes(o.anchor, op.operation.request))).toEqual(
      domain(
        'join/v1',
        ok(encodeCbor([o.anchor.toBytes(), id(11), filled(11), bob.pk, bob.enc, null]))
      )
    );
    o.append(owner, o.device(phone, 0));
    const d = ok(Ledger.decodeRecord(o.records[2])).body;
    if (d.type !== 'ordinary' || d.operation.type !== 'admitDevice') throw new Error('fixture');
    expect(
      ok(
        Ledger.possessionSigningBytes({
          genesis: o.anchor,
          targetMembershipId: ok(Bytes.membershipId(id(10))),
          ...d.operation,
        })
      )
    ).toEqual(
      domain('possess/v2', ok(encodeCbor([o.anchor.toBytes(), id(10), phone.pk, phone.enc, 0])))
    );
    expect(ok(o.verify()).length).toBe(3);
  });
  it('rejects every byte truncation, trailing bytes, noncanonical integers and unknown versions/tags', () => {
    const o = org(),
      record = o.records[0]!;
    for (let n = 0; n < record.length; n++)
      expect(Result.isFailure(Ledger.decodeRecord(record.slice(0, n))), `cut ${n}`).toBe(true);
    expect(Result.isFailure(Ledger.decodeRecord(new Uint8Array([...record, 0])))).toBe(true);
    expect(
      Result.isFailure(
        Ledger.decodeRecord(new Uint8Array([...record.slice(0, 2), 0x18, 1, ...record.slice(3)]))
      )
    ).toBe(true);
    expect(
      code(
        Ledger.decodeRecord(signed([2, owner.pk, filled(10), id(10), owner.enc, filled(20)], owner))
      )
    ).toBe('unknown-version');
    for (const op of [[99], [2, id(11)]]) {
      expect(code(Ledger.decodeRecord(signed([o.anchor.toBytes(), owner.pk, op], owner)))).toBe(
        'unknown-operation'
      );
    }
    for (const op of [
      [3, id(11), 0],
      [4, 3, phone.pk, phone.enc, filled(0, 64)],
      [7, 0, filled(1), filled(2, 72)],
      [7, 1, filled(1), filled(2, 71)],
    ])
      expect(
        Result.isFailure(Ledger.decodeRecord(signed([o.anchor.toBytes(), owner.pk, op], owner)))
      ).toBe(true);
  });
  it('rejects empty/missing/duplicated/reordered records and mismatched checkpoints', () => {
    const o = org();
    o.append(owner, o.join(bob, 11));
    o.append(owner, [3, id(11), 1]);
    const endpoint = checkpoint(o.records);
    for (const records of [
      [],
      o.records.slice(0, 2),
      [o.records[0]!, o.records[2]!],
      [...o.records, o.records[2]!],
      [o.records[0]!, o.records[2]!, o.records[1]!],
    ])
      expect(
        Result.isFailure(Ledger.verifyLedger({ anchor: o.anchor, records, checkpoint: endpoint }))
      ).toBe(true);
    const dup = [o.records[0]!, o.records[1]!, o.records[1]!];
    expect(
      code(Ledger.verifyLedger({ anchor: o.anchor, records: dup, checkpoint: checkpoint(dup) }))
    ).toBe('wrong-parent');
    expect(
      code(
        Ledger.verifyLedger({
          anchor: o.anchor,
          records: o.records,
          checkpoint: { ...endpoint, head: ok(Bytes.recordHash(filled(99))) },
        })
      )
    ).toBe('checkpoint-mismatch');
  });
  it('rejects wrong genesis, signatures, predecessor and cross-Org proofs', () => {
    const o = org();
    expect(
      code(
        Ledger.verifyLedger({
          anchor: ok(Bytes.genesisHash(filled(99))),
          records: o.records,
          checkpoint: checkpoint(o.records),
        })
      )
    ).toBe('wrong-anchor');
    o.append(owner, [7, 1, filled(21), filled(30, 72)], filled(0, 64));
    const r = o.verify();
    expect(code(r)).toBe('bad-signature');
    expect(Result.isFailure(r) && r.failure.position).toBe(1);
    for (const attack of [
      'parent',
      'join-org',
      'possession-org',
      'possession-membership',
      'possession-kind',
      'join-key',
      'outer-key',
    ]) {
      const p = org();
      if (attack === 'parent')
        p.append(owner, [7, 1, filled(21), filled(30, 72)], undefined, filled(90));
      if (attack === 'join-org')
        p.append(owner, p.join(bob, 11, ok(Bytes.genesisHash(filled(99)))));
      if (attack === 'possession-org')
        p.append(owner, p.device(phone, 0, id(10), ok(Bytes.genesisHash(filled(99)))));
      if (attack === 'possession-membership') p.append(owner, p.device(phone, 0, id(11)));
      if (attack === 'possession-kind') {
        const d = [...p.device(phone, 0)];
        d[1] = 1;
        p.append(owner, [...d, new TextEncoder().encode('machine'), null]);
      }
      if (attack === 'join-key') {
        const j = p.join(bob, 11);
        const req = [...j[2]];
        req[2] = carol.pk;
        p.append(owner, [1, id(11), req]);
      }
      if (attack === 'outer-key') {
        const body = [p.anchor.toBytes(), owner.pk, [7, 1, filled(21), filled(30, 72)]] as const;
        p.records.push(signed(body, attacker));
      }
      expect(code(p.verify()), attack).toBe(
        attack === 'parent'
          ? 'wrong-parent'
          : attack === 'outer-key'
            ? 'bad-signature'
            : 'bad-proof'
      );
    }
  });
});

describe('atomic member removal and epoch publication', () => {
  const publicKey = (key: Keys) => ok(Bytes.signingPublicKey(key.pk));
  const permissions = (view: Ledger.LedgerView, key: Keys) =>
    ok(Ledger.contentPermissions(view, publicKey(key)));
  const fullAuthor = (view: Ledger.LedgerView, key: Bytes.SigningPublicKey) => {
    const author = ok(Snapshots.historicalContentIdentity(view, key));
    if (author.kind !== 'member') throw new Error('expected original author facts');
    return author;
  };
  function populated() {
    const o = org();
    o.append(owner, o.join(bob, 11));
    for (const [device, kind] of [
      [phone, 0],
      [machine, 1],
      [recovery, 2],
    ] as const)
      o.append(bob, o.device(device, kind, id(11)));
    o.append(owner, o.join(carol, 12));
    return o;
  }
  const operation = (
    member = id(11),
    epoch = 1,
    commitment = filled(21),
    packet = filled(30, 72)
  ) => [8, member, epoch, commitment, packet] as const;
  it('removes every target device and enables the next epoch in one signed record while preserving history', () => {
    const o = populated();
    o.append(bob, [5, phone.pk]);
    const before = ok(o.verify()),
      original = comparable(before);
    expect(before.inspectState().epoch.rotationRequired).toBe(true);
    const record = signed([before.head.toBytes(), owner.pk, operation()], owner);
    const view = ok(
      Ledger.extendLedger(before, [record], {
        head: Ledger.hashRecordBytes(record),
        length: before.length + 1,
      })
    );
    const decoded = ok(Ledger.decodeRecord(record));
    expect(decoded.body.type === 'ordinary' && decoded.body.operation.type).toBe(
      'removeMemberAndPublishEpoch'
    );
    expect(view.length).toBe(before.length + 1);
    expect(view.inspectState().members.has(keyId(id(11)))).toBe(false);
    expect(view.inspectState().members.has(keyId(id(12)))).toBe(true);
    for (const device of [bob, phone, machine, recovery]) {
      expect(view.inspectState().devices.has(keyId(device.pk))).toBe(false);
      expect(permissions(view, device)).toEqual({
        mayWriteDocument: false,
        maySealNewContent: false,
      });
      expect(hex(fullAuthor(view, publicKey(device)).memberInstance)).toBe(keyId(id(11)));
    }
    expect(view.inspectState().devices.has(keyId(owner.pk))).toBe(true);
    expect(view.inspectState().devices.has(keyId(carol.pk))).toBe(true);
    expect(view.inspectState().epoch).toMatchObject({ number: 1, rotationRequired: false });
    expect(ok(Ledger.epochHistoryPacket(view, 1)).packet).toEqual(filled(30, 72));
    expect(hex(ok(Ledger.epochHistoryPacket(view, 0)).commitment)).toBe(keyId(filled(20)));
    expect(comparable(before)).toEqual(original);
    expect(permissions(view, owner).maySealNewContent).toBe(true);
  });
  it('checks pre-state Owner personal authority, target and epoch before publishing any successor', () => {
    const o = populated();
    o.append(owner, [3, id(11), 1]);
    const base = ok(o.verify()),
      original = comparable(base);
    const cases: readonly [Keys, readonly CborValue[], Ledger.LedgerError['code']][] = [
      [bob, operation(), 'unauthorized'],
      [machine, operation(), 'unauthorized'],
      [recovery, operation(), 'unauthorized'],
      [carol, operation(), 'unauthorized'],
      [owner, operation(id(10)), 'unauthorized'],
      [owner, operation(id(99)), 'unauthorized'],
      [owner, operation(id(11), 2), 'invalid-operation'],
      [owner, operation(id(11), 1, filled(20)), 'replay'],
    ];
    for (const [actor, op, expected] of cases) {
      const record = signed([base.head.toBytes(), actor.pk, op], actor);
      expect(
        code(
          Ledger.extendLedger(base, [record], {
            head: Ledger.hashRecordBytes(record),
            length: base.length + 1,
          })
        )
      ).toBe(expected);
      expect(comparable(base)).toEqual(original);
      expect(base.inspectState().members.has(keyId(id(11)))).toBe(true);
      expect(base.inspectState().epoch.number).toBe(0);
    }
    for (const op of [
      [2, id(11)],
      operation(id(11), 0),
      operation(id(11), 1, filled(21), filled(30, 71)),
      [8, id(11), 1, filled(21), filled(30, 72), 0],
    ]) {
      const record = signed([base.head.toBytes(), owner.pk, op], owner);
      expect(Result.isFailure(Ledger.decodeRecord(record))).toBe(true);
    }
  });
  it('retains retired member and device replay prevention in full replay and the single snapshot format', () => {
    const o = populated(),
      before = ok(o.verify()),
      priorSnapshot = ok(Snapshots.verifyLedgerSnapshot(endorsed(before)));
    const record = o.append(owner, operation()),
      full = ok(o.verify());
    const suffix = ok(Ledger.extendLedger(priorSnapshot, [record], checkpoint(o.records)));
    const fresh = ok(Snapshots.verifyLedgerSnapshot(endorsed(full)));
    for (const view of [suffix, fresh]) {
      expect(comparable(view)).toEqual(comparable(full));
      expect(hex(ok(Snapshots.comparisonNote(view, publicKey(owner))).stateDigest)).toBe(
        hex(ok(Snapshots.comparisonNote(full, publicKey(owner))).stateDigest)
      );
      // A reader holding no device gets the same digest as the members' notes.
      expect(hex(ok(Snapshots.ledgerStateDigest(view)))).toBe(
        hex(ok(Snapshots.comparisonNote(full, publicKey(owner))).stateDigest)
      );
      expect(ok(Ledger.epochHistoryPacket(view, 1)).packet).toEqual(filled(30, 72));
      for (const op of [o.join(attacker, 11), o.join(bob, 13), o.device(phone, 0, id(10))]) {
        const reuse = signed([view.head.toBytes(), owner.pk, op], owner);
        expect(
          code(
            Ledger.extendLedger(view, [reuse], {
              head: Ledger.hashRecordBytes(reuse),
              length: view.length + 1,
            })
          )
        ).toBe('replay');
      }
    }
    for (const view of [fresh, suffix])
      expect(hex(fullAuthor(view, publicKey(bob)).memberInstance)).toBe(keyId(id(11)));
    // The removal record is authenticated at its one exact position; old-point
    // trust never accepts a new post-removal state merely because the signer agrees.
    expect(
      code(
        Snapshots.verifyLedgerSnapshot({
          snapshot: endorsed(full).snapshot,
          trust: endorsed(before).trust,
        })
      )
    ).toBe('checkpoint-mismatch');
  });
  it('accepts a currently authorized second Owner personal device, but never a target that became Owner', () => {
    const o = org();
    o.append(owner, o.device(phone, 0));
    o.append(owner, o.join(bob, 11));
    const before = ok(o.verify()),
      candidate = signed([before.head.toBytes(), phone.pk, operation()], phone);
    expect(
      Result.isSuccess(
        Ledger.extendLedger(before, [candidate], {
          head: Ledger.hashRecordBytes(candidate),
          length: before.length + 1,
        })
      )
    ).toBe(true);
    o.append(owner, [6, id(11)]);
    const transferred = ok(o.verify());
    const invalid = signed([transferred.head.toBytes(), owner.pk, operation()], owner);
    expect(
      code(
        Ledger.extendLedger(transferred, [invalid], {
          head: Ledger.hashRecordBytes(invalid),
          length: transferred.length + 1,
        })
      )
    ).toBe('unauthorized');
  });
});

describe('deterministic permissions from preceding state', () => {
  it.each(['member', 'guest', 'admin'] as const)(
    '%s cannot change roles or transfer Owner',
    (role) => {
      for (const op of [
        [3, id(12), 1],
        [6, id(12)],
      ]) {
        const o = org();
        o.append(owner, o.join(bob, 11));
        o.append(owner, o.join(carol, 12));
        if (role !== 'member') o.append(owner, [3, id(11), role === 'guest' ? 3 : 1]);
        o.append(bob, op);
        expect(code(o.verify())).toBe('unauthorized');
      }
    }
  );
  it.each(['member', 'guest'] as const)('%s cannot invite or publish epochs', (role) => {
    for (const operation of ['join', 'epoch']) {
      const o = org();
      o.append(owner, o.join(bob, 11));
      if (role === 'guest') o.append(owner, [3, id(11), 3]);
      o.append(bob, operation === 'join' ? o.join(carol, 12) : [7, 1, filled(21), filled(30, 72)]);
      expect(code(o.verify())).toBe('unauthorized');
    }
  });
  it.each([1, 2])('Owner device kind %i cannot manage, revoke, or invite', (kind) => {
    for (const op of ['epoch', 'join', 'revoke', 'transfer']) {
      const o = org();
      o.append(owner, o.join(bob, 11));
      o.append(owner, o.device(machine, kind));
      o.append(
        machine,
        op === 'epoch'
          ? [7, 1, filled(21), filled(30, 72)]
          : op === 'join'
            ? o.join(carol, 12)
            : op === 'revoke'
              ? [5, owner.pk]
              : [6, id(11)]
      );
      expect(code(o.verify())).toBe('unauthorized');
    }
  });
  it('Admin can invite Member and rotate; demotion removes management from all personal devices', () => {
    const o = org();
    o.append(owner, o.join(bob, 11));
    o.append(owner, [3, id(11), 1]);
    o.append(bob, o.device(phone, 0, id(11)));
    o.append(phone, o.join(carol, 12));
    o.append(phone, [7, 1, filled(21), filled(30, 72)]);
    expect(
      ok(o.verify())
        .inspectState()
        .members.get(keyId(id(12)))?.role
    ).toBe('member');
    o.append(owner, [3, id(11), 2]);
    const view = ok(o.verify());
    for (const signer of [bob, phone]) {
      const record = signed(
        [view.head.toBytes(), signer.pk, [7, 2, filled(22), filled(30, 72)]],
        signer
      );
      expect(
        code(
          Ledger.extendLedger(view, [record], {
            head: Ledger.hashRecordBytes(record),
            length: view.length + 1,
          })
        )
      ).toBe('unauthorized');
    }
  });
  it('Owner cannot demote itself or revoke its last governing device, and cannot revoke another member device', () => {
    for (const op of [
      [3, id(10), 1],
      [5, owner.pk],
      [5, bob.pk],
    ]) {
      const o = org();
      o.append(owner, o.join(bob, 11));
      o.append(owner, op);
      expect(code(o.verify())).toBe('unauthorized');
    }
  });
  it('recovery admits only own personal devices; revoked approver does not revoke its approved child', () => {
    const o = org();
    o.append(owner, o.device(recovery, 2));
    o.append(recovery, o.device(phone, 0));
    o.append(owner, [5, recovery.pk]);
    const view = ok(o.verify());
    expect(view.inspectState().devices.has(keyId(phone.pk))).toBe(true);
    o.append(phone, [7, 1, filled(21), filled(30, 72)]);
    expect(code(o.verify())).toBe('accepted');
    for (const kind of [1, 2]) {
      const p = org();
      p.append(owner, p.device(recovery, 2));
      p.append(recovery, p.device(phone, kind));
      expect(code(p.verify())).toBe('unauthorized');
    }
  });
  it('Guest can recover own personal device, cannot register machine; Owner may transfer to a Guest with R', () => {
    const o = org();
    o.append(owner, o.join(bob, 11));
    o.append(bob, o.device(recovery, 2, id(11)));
    o.append(owner, [3, id(11), 3]);
    o.append(recovery, o.device(phone, 0, id(11)));
    o.append(bob, [5, bob.pk]);
    o.append(owner, [6, id(11)]);
    const s = ok(o.verify()).inspectState();
    expect(hex(s.owner)).toBe(keyId(id(11)));
    expect(s.members.get(keyId(id(10)))?.role).toBe('admin');
    const p = org();
    p.append(owner, p.join(bob, 11));
    p.append(owner, [3, id(11), 3]);
    p.append(bob, p.device(machine, 1, id(11)));
    expect(code(p.verify())).toBe('unauthorized');
  });
  it('transfer rejects a member whose only remaining device is a machine', () => {
    const o = org();
    o.append(owner, o.join(bob, 11));
    o.append(bob, o.device(machine, 1, id(11)));
    o.append(bob, [5, bob.pk]);
    o.append(owner, [6, id(11)]);
    expect(code(o.verify())).toBe('unauthorized');
  });
  it('rejects used membership, user, signing/encryption keys, revoked key reuse and repeated epoch commitments', () => {
    for (const replay of ['membership', 'user', 'signing', 'encryption', 'revoked', 'commitment']) {
      const o = org();
      o.append(owner, o.join(bob, 11));
      if (replay === 'membership') o.append(owner, o.join(carol, 11));
      if (replay === 'user') {
        const j = o.join(carol, 11);
        o.append(owner, [1, id(12), j[2]]);
      }
      if (replay === 'signing') o.append(bob, o.device(bob, 0, id(11)));
      if (replay === 'encryption') {
        const reused = { ...phone, enc: bob.enc };
        o.append(bob, o.device(reused, 0, id(11)));
      }
      if (replay === 'revoked') {
        o.append(owner, o.device(phone, 0));
        o.append(owner, [5, phone.pk]);
        o.append(owner, o.device(phone, 0));
      }
      if (replay === 'commitment') o.append(owner, [7, 1, filled(20), filled(30, 72)]);
      expect(code(o.verify()), replay).toBe('replay');
    }
  });
  it('enforces epoch order and revoked signer authorization', () => {
    const o = org();
    o.append(owner, o.device(phone, 0));
    o.append(owner, [5, phone.pk]);
    o.append(phone, [7, 1, filled(21), filled(30, 72)]);
    expect(code(o.verify())).toBe('unauthorized');
    const p = org();
    p.append(owner, [7, 2, filled(21), filled(30, 72)]);
    expect(code(p.verify())).toBe('invalid-operation');
  });
});

describe('verified view is a runtime boundary', () => {
  it('full replay equals every incremental split and repeated replay', () => {
    const o = org();
    o.append(owner, o.join(bob, 11));
    o.append(owner, [3, id(11), 1]);
    o.append(bob, o.device(recovery, 2, id(11)));
    o.append(recovery, o.device(phone, 0, id(11)));
    o.append(bob, [5, recovery.pk]);
    o.append(owner, [6, id(11)]);
    o.append(phone, [7, 1, filled(21), filled(30, 72)]);
    const full = ok(o.verify());
    for (let split = 1; split <= o.records.length; split++) {
      const prefix = o.records.slice(0, split);
      const view = ok(
        Ledger.verifyLedger({ anchor: o.anchor, records: prefix, checkpoint: checkpoint(prefix) })
      );
      expect(
        comparable(ok(Ledger.extendLedger(view, o.records.slice(split), checkpoint(o.records))))
      ).toEqual(comparable(full));
    }
    expect(comparable(ok(o.verify()))).toEqual(comparable(full));
  });
  it('failed suffix, checkpoint and inspection mutation cannot advance or alter a view', () => {
    const o = org();
    const view = ok(o.verify()),
      before = comparable(view);
    const inspection = view.inspectState();
    (inspection.devices as Map<string, unknown>).clear();
    (inspection.members as Map<string, unknown>).clear();
    inspection.owner.toBytes().fill(99);
    expect(comparable(view)).toEqual(before);
    const good = signed([view.head.toBytes(), owner.pk, [7, 1, filled(21), filled(30, 72)]], owner);
    const bad = signed(
      [Ledger.hashRecordBytes(good).toBytes(), owner.pk, [7, 2, filled(22), filled(30, 72)]],
      owner,
      filled(0, 64)
    );
    expect(
      code(Ledger.extendLedger(view, [good, bad], { head: Ledger.hashRecordBytes(bad), length: 3 }))
    ).toBe('bad-signature');
    expect(comparable(view)).toEqual(before);
    expect(code(Ledger.extendLedger(view, [good], { head: view.head, length: 2 }))).toBe(
      'checkpoint-mismatch'
    );
    expect(comparable(view)).toEqual(before);
    expect(
      ok(
        Ledger.extendLedger(view, [good], { head: Ledger.hashRecordBytes(good), length: 2 })
      ).inspectState().epoch.number
    ).toBe(1);
  });
  it('refuses structural/prototype clones and cannot expose a constructor to mint trusted state', () => {
    const o = org();
    const view = ok(o.verify());
    expect(Object.getPrototypeOf(view)).toBe(null);
    expect(Reflect.get(view, 'constructor')).toBeUndefined();
    for (const fake of [{ ...view }, Object.create(view), Object.assign(Object.create(null), view)])
      expect(code(Ledger.extendLedger(fake, [], { head: view.head, length: view.length }))).toBe(
        'unauthorized'
      );
    // Permissive verifier injection is not a public capability; even forced extra arguments cannot bypass verification.
    o.append(owner, [7, 1, filled(21), filled(30, 72)], filled(0, 64));
    expect(
      code(
        Ledger.verifyLedger({
          anchor: o.anchor,
          records: o.records,
          checkpoint: checkpoint(o.records),
          verifier: () => true,
        } as Parameters<typeof Ledger.verifyLedger>[0])
      )
    ).toBe('bad-signature');
  });
});

const fullAuthor = (view: Ledger.LedgerView, device: Bytes.SigningPublicKey) => {
  const identity = ok(Snapshots.historicalContentIdentity(view, device));
  expect(identity.kind).toBe('member');
  if (identity.kind !== 'member') throw new Error('missing full-history member attribution');
  return identity;
};

describe('verified historical facts and current content permissions', () => {
  const publicKey = (key: Keys) => ok(Bytes.signingPublicKey(key.pk));
  const permissions = (view: Ledger.LedgerView, key: Keys) =>
    ok(Ledger.contentPermissions(view, publicKey(key)));
  it('retains admission identity after revocation without granting current write rights', () => {
    const o = org();
    o.append(owner, o.join(bob, 11));
    o.append(bob, o.device(phone, 0, id(11)));
    const prior = ok(o.verify());
    expect(permissions(prior, phone)).toEqual({ mayWriteDocument: true, maySealNewContent: true });
    o.append(bob, [5, phone.pk]);
    const current = ok(o.verify());
    const author = ok(Snapshots.historicalContentIdentity(current, publicKey(phone)));
    expect(author.kind).toBe('member');
    if (author.kind !== 'member') throw new Error('missing full-history member attribution');
    expect(hex(author.device)).toBe(keyId(phone.pk));
    expect(hex(author.actor)).toBe(keyId(filled(11)));
    expect(hex(author.memberInstance)).toBe(keyId(id(11)));
    author.actor.toBytes().fill(0);
    author.memberInstance.toBytes().fill(0);
    expect(hex(fullAuthor(current, publicKey(phone)).actor)).toBe(keyId(filled(11)));
    expect(permissions(current, phone)).toEqual({
      mayWriteDocument: false,
      maySealNewContent: false,
    });
    expect(permissions(prior, phone)).toEqual({ mayWriteDocument: true, maySealNewContent: true });
    expect(code(Snapshots.historicalContentIdentity(current, publicKey(attacker)))).toBe(
      'unauthorized'
    );
  });
  it('distinguishes host admission from the honest seal rotation gate', () => {
    const o = org();
    o.append(owner, o.device(phone, 0));
    o.append(owner, [5, phone.pk]);
    const pending = ok(o.verify());
    expect(permissions(pending, owner)).toEqual({
      mayWriteDocument: true,
      maySealNewContent: false,
    });
    o.append(owner, [7, 1, filled(21), filled(30, 72)]);
    const rotated = ok(
      Ledger.extendLedger(pending, [o.records[o.records.length - 1]!], checkpoint(o.records))
    );
    expect(permissions(rotated, owner)).toEqual({
      mayWriteDocument: true,
      maySealNewContent: true,
    });
    expect(permissions(pending, owner).maySealNewContent).toBe(false);
    expect(permissions(rotated, phone).mayWriteDocument).toBe(false);
  });
  it('uses current role/kind for permission and admission history for attribution', () => {
    const o = org();
    o.append(owner, o.join(bob, 11));
    o.append(bob, o.device(machine, 1, id(11)));
    o.append(bob, o.device(recovery, 2, id(11)));
    const member = ok(o.verify());
    expect(permissions(member, bob).mayWriteDocument).toBe(true);
    expect(permissions(member, machine).mayWriteDocument).toBe(true);
    expect(permissions(member, recovery)).toEqual({
      mayWriteDocument: false,
      maySealNewContent: false,
    });
    o.append(owner, [3, id(11), 3]);
    const guest = ok(o.verify());
    for (const key of [bob, machine, recovery]) {
      expect(permissions(guest, key)).toEqual({
        mayWriteDocument: false,
        maySealNewContent: false,
      });
      expect(hex(fullAuthor(guest, publicKey(key)).actor)).toBe(keyId(filled(11)));
    }
    expect(permissions(guest, attacker)).toEqual({
      mayWriteDocument: false,
      maySealNewContent: false,
    });
    o.append(owner, [3, id(11), 1]);
    const admin = ok(o.verify());
    expect(permissions(admin, machine).mayWriteDocument).toBe(true);
    expect(permissions(admin, recovery).mayWriteDocument).toBe(false);
  });
  it('returns owned signed epoch facts, not invented keys or packet validity', () => {
    const o = org();
    const genesis = ok(o.verify());
    expect(ok(Ledger.epochHistoryPacket(genesis, 0)).packet).toHaveLength(0);
    expect(hex(ok(Ledger.epochHistoryPacket(genesis, 0)).commitment)).toBe(keyId(filled(20)));
    expect(code(Ledger.epochHistoryPacket(genesis, 1))).toBe('unauthorized');
    o.append(owner, [7, 1, filled(21), filled(30, 72)]);
    o.append(owner, [7, 2, filled(22), filled(31, 72)]);
    const full = ok(o.verify());
    for (let split = 1; split <= o.records.length; split++) {
      const prefix = o.records.slice(0, split);
      const view = ok(
        Ledger.extendLedger(
          ok(
            Ledger.verifyLedger({
              anchor: o.anchor,
              records: prefix,
              checkpoint: checkpoint(prefix),
            })
          ),
          o.records.slice(split),
          checkpoint(o.records)
        )
      );
      for (const epoch of [1, 2]) {
        const row = ok(Ledger.epochHistoryPacket(view, epoch));
        expect(row.epoch).toBe(epoch);
        expect(row.packet).toEqual(filled(29 + epoch, 72));
        expect(hex(row.commitment)).toBe(keyId(filled(20 + epoch)));
        row.packet.fill(0);
        expect(ok(Ledger.epochHistoryPacket(view, epoch)).packet).toEqual(filled(29 + epoch, 72));
      }
    }
    for (const invalid of [-1, 1.5, NaN, Infinity, 2 ** 32])
      expect(Result.isFailure(Ledger.epochHistoryPacket(full, invalid))).toBe(true);
    expect(code(Ledger.epochHistoryPacket(full, 3))).toBe('unauthorized');
    expect(code(Ledger.epochHistoryPacket(genesis, 1))).toBe('unauthorized');
  });
  it('does not disclose facts or permissions through forged/cloned views or failed suffixes', () => {
    const o = org(),
      view = ok(o.verify());
    for (const fake of [
      { ...view },
      { ...view, inspectState: () => view.inspectState() },
      Object.create(view),
    ] as Ledger.LedgerView[]) {
      expect(code(Snapshots.historicalContentIdentity(fake, publicKey(owner)))).toBe(
        'unauthorized'
      );
      expect(code(Ledger.contentPermissions(fake, publicKey(owner)))).toBe('unauthorized');
      expect(code(Ledger.epochHistoryPacket(fake, 0))).toBe('unauthorized');
    }
    o.append(owner, o.join(bob, 11));
    o.append(owner, [7, 1, filled(21), filled(30, 72)], new Uint8Array(64));
    expect(
      Result.isFailure(Ledger.extendLedger(view, o.records.slice(1), checkpoint(o.records)))
    ).toBe(true);
    expect(code(Snapshots.historicalContentIdentity(view, publicKey(bob)))).toBe('unauthorized');
    expect(code(Ledger.epochHistoryPacket(view, 1))).toBe('unauthorized');
    expect(permissions(view, owner).maySealNewContent).toBe(true);
  });
});

describe('authorized ordinary record preparation and signing', () => {
  const signer = (key: Keys): DeviceSigner => ({
    publicKey: ok(Bytes.signingPublicKey(key.pk)),
    sign: (message) => Effect.sync(() => ok(Bytes.signature(key.sign(message)))),
  });
  it('owns canonical unsigned bytes, signs the exact parent and passes real replay', async () => {
    const o = org(),
      view = ok(o.verify());
    const body = ok(
      encodeCbor([view.head.toBytes(), owner.pk, [7, 1, filled(21), filled(30, 72)]])
    );
    const proposal = ok(Commands.prepareLedgerRecord(view, body));
    const expectedMessage = domain('sig/v1', body);
    body.fill(0);
    expect(proposal.signingBytes()).toEqual(expectedMessage);
    proposal.signingBytes().fill(0);
    const record = await Effect.runPromise(Commands.signLedgerRecord(proposal, signer(owner)));
    expect(ok(Ledger.decodeRecord(record)).bodyBytes).toEqual(
      expectedMessage.subarray(new TextEncoder().encode('lody-e2ee/sig/v1\0').length)
    );
    const next = ok(
      Ledger.extendLedger(view, [record], {
        head: Ledger.hashRecordBytes(record),
        length: view.length + 1,
      })
    );
    expect(next.inspectState().epoch.number).toBe(1);
    expect(view.inspectState().epoch.number).toBe(0);
  });
  it('checks genuine view, exact parent, governing permission and nested Org/member/kind proofs before signing', () => {
    const o = org(),
      view = ok(o.verify());
    const body = (who: Keys, op: readonly CborValue[], parent = view.head.toBytes()) =>
      ok(encodeCbor([parent, who.pk, op]));
    expect(
      code(
        Commands.prepareLedgerRecord({ ...view }, body(owner, [7, 1, filled(21), filled(30, 72)]))
      )
    ).toBe('unauthorized');
    expect(
      code(Commands.prepareLedgerRecord(view, body(attacker, [7, 1, filled(21), filled(30, 72)])))
    ).toBe('unauthorized');
    expect(
      code(
        Commands.prepareLedgerRecord(
          view,
          body(owner, [7, 1, filled(21), filled(30, 72)], filled(99))
        )
      )
    ).toBe('wrong-parent');
    const foreign = org();
    foreign.append(owner, foreign.device(phone, 0));
    const foreignAnchor = ok(
      Bytes.genesisHash(Ledger.hashRecordBytes(foreign.records[1]!).toBytes())
    );
    expect(
      code(Commands.prepareLedgerRecord(view, body(owner, o.join(bob, 11, foreignAnchor))))
    ).toBe('bad-proof');
    expect(code(Commands.prepareLedgerRecord(view, body(owner, o.device(phone, 1, id(11)))))).toBe(
      'bad-proof'
    );
    expect(code(Commands.prepareLedgerRecord(view, body(owner, [2, id(11)])))).toBe(
      'unknown-operation'
    );
    expect(Result.isFailure(Commands.prepareLedgerRecord(view, new Uint8Array(8193)))).toBe(true);
    expect(comparable(view)).toEqual(comparable(ok(o.verify())));
  });
  it('rejects fabricated proposals, wrong signer and bad signer output with prior view intact', async () => {
    const o = org(),
      view = ok(o.verify()),
      before = comparable(view);
    const proposal = ok(
      Commands.prepareLedgerRecord(
        view,
        ok(encodeCbor([view.head.toBytes(), owner.pk, [7, 1, filled(21), filled(30, 72)]]))
      )
    );
    const result = (work: ReturnType<typeof Commands.signLedgerRecord>) =>
      Effect.runPromise(Effect.result(work));
    expect(
      Result.isFailure(await result(Commands.signLedgerRecord({ ...proposal }, signer(owner))))
    ).toBe(true);
    expect(
      Result.isFailure(await result(Commands.signLedgerRecord(proposal, signer(attacker))))
    ).toBe(true);
    const bad: DeviceSigner = {
      publicKey: signer(owner).publicKey,
      sign: () => Effect.succeed(ok(Bytes.signature(new Uint8Array(64)))),
    };
    expect(Result.isFailure(await result(Commands.signLedgerRecord(proposal, bad)))).toBe(true);
    expect(comparable(view)).toEqual(before);
  });
  it('signs valid target possession proof and remains only parent-relative evidence after a competing suffix', async () => {
    const o = org(),
      view = ok(o.verify());
    const proposal = ok(
      Commands.prepareLedgerRecord(
        view,
        ok(encodeCbor([view.head.toBytes(), owner.pk, o.device(phone, 0)]))
      )
    );
    const original = await Effect.runPromise(Commands.signLedgerRecord(proposal, signer(owner)));
    const accepted = ok(
      Ledger.extendLedger(view, [original], { head: Ledger.hashRecordBytes(original), length: 2 })
    );
    expect(accepted.inspectState().devices.has(keyId(phone.pk))).toBe(true);
    o.append(owner, [7, 1, filled(21), filled(30, 72)]);
    const moved = ok(o.verify());
    expect(
      code(
        Ledger.extendLedger(moved, [original], {
          head: Ledger.hashRecordBytes(original),
          length: moved.length + 1,
        })
      )
    ).toBe('wrong-parent');
    expect(accepted.length).toBe(2);
    expect(view.length).toBe(1);
  });
});

it('submits prepared signed bytes through real SQLite and recovers without a live signer', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'e2ee-signed-command-'));
  const remote = SubmissionFixture.host(path.join(directory, 'host.sqlite'));
  const journal = path.join(directory, 'pending.sqlite');
  try {
    const records = remote.read();
    const view = ok(
      Ledger.verifyLedger({
        anchor: SubmissionFixture.anchor,
        records,
        checkpoint: SubmissionFixture.checkpoint(records),
      })
    );
    const previousIndependent = SubmissionFixture.rotate();
    const proposal = ok(
      Commands.prepareLedgerRecord(view, ok(Ledger.decodeRecord(previousIndependent)).bodyBytes)
    );
    const produced = await Effect.runPromise(
      Commands.signLedgerRecord(proposal, {
        publicKey: ok(Bytes.signingPublicKey(SubmissionFixture.owner.pk)),
        sign: (message) =>
          Effect.sync(() => ok(Bytes.signature(SubmissionFixture.owner.sign(message)))),
      })
    );
    expect(produced).toEqual(previousIndependent);
    const lostResponse = {
      ...remote.service,
      appendCas: (
        anchor: typeof SubmissionFixture.anchor,
        expected: Ledger.LedgerCheckpoint,
        record: Uint8Array
      ) =>
        Effect.gen(function* () {
          yield* remote.service.appendCas(anchor, expected, record);
          return yield* new LedgerLogError();
        }),
    };
    const run = <A, E>(
      work: Effect.Effect<A, E, LedgerLog | SubmissionJournal>,
      service = remote.service
    ) =>
      Effect.runPromise(
        work.pipe(
          Effect.provideService(LedgerLog, service),
          Effect.provide(sqliteSubmissionJournal({ path: journal }))
        )
      );
    const committed = await run(submitRecord(SubmissionFixture.anchor, produced), lostResponse);
    expect(committed).toEqual({ outcome: 'Committed', record: produced });
    expect(await run(resumeSubmission(SubmissionFixture.anchor))).toEqual(committed);
    expect(remote.read()).toEqual([SubmissionFixture.genesis, produced]);
  } finally {
    remote.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
function endorsed(view: Ledger.LedgerView, signer: Keys = owner) {
  const proposal = ok(Snapshots.prepareLedgerSnapshot(view, ok(Bytes.signingPublicKey(signer.pk))));
  const device = view.inspectState().devices.get(keyId(signer.pk))!;
  const role = view.inspectState().members.get(keyId(device.membershipId.toBytes()))!.role;
  if (role !== 'owner' && role !== 'admin') throw new Error('fixture endorser');
  const trust: Snapshots.SnapshotTrust = {
    source: 'external-confirmation',
    membershipId: device.membershipId,
    role,
    kind: 'personal',
    genesis: view.genesis,
    endorser: ok(Bytes.signingPublicKey(signer.pk)),
    head: view.head,
    length: view.length,
    headSignature: ok(Bytes.signature(signer.sign(proposal.headAttestationSigningBytes))),
  };
  return {
    snapshot: ok(
      Snapshots.encodeSignedSnapshot(
        proposal.bodyBytes,
        ok(Bytes.signature(signer.sign(proposal.signingBytes)))
      )
    ),
    trust,
    proposal,
  };
}
function editedSnapshot(view: Ledger.LedgerView, signer: Keys, edit: (body: CborValue[]) => void) {
  const original = endorsed(view, signer);
  const body = ok(decodeSnapshotCbor(original.proposal.bodyBytes)) as CborValue[];
  edit(body);
  const bytes = ok(encodeSnapshotCbor(body));
  return {
    ...original,
    snapshot: ok(
      Snapshots.encodeSignedSnapshot(
        bytes,
        ok(Bytes.signature(signer.sign(Snapshots.snapshotSigningBytes(bytes))))
      )
    ),
  };
}
// The authorization state's fixed-width tables (memberships, devices, joins,
// commitments, packets) as editable rows, for tampering tests.
const STATE_ROWS = [49, 70, 20, 32, 72] as const;
function stateRows(state: CborValue[]): Uint8Array[][] {
  return STATE_ROWS.map((width, field) => {
    const bytes = state[field] as Uint8Array;
    return Array.from({ length: bytes.length / width }, (_, row) =>
      bytes.slice(row * width, (row + 1) * width)
    );
  });
}
function setStateRows(state: CborValue[], rows: Uint8Array[][]) {
  rows.forEach((table, field) => {
    state[field] = Uint8Array.from(table.flatMap((row) => [...row]));
  });
}
const deviceRow = (rows: Uint8Array[][], key: Keys) =>
  rows[1]!.find((row) => keyId(row.subarray(0, 32)) === keyId(key.pk))!;
describe('authenticated snapshot migration reproduction', () => {
  it('joins from independently pinned endorsement and extends the same canonical suffix', () => {
    const o = org();
    o.append(owner, o.join(bob, 11));
    o.append(owner, [3, id(11), 1]);
    const before = ok(o.verify());
    const imported = ok(Snapshots.verifyLedgerSnapshot(endorsed(before, bob)));
    expect(comparable(imported)).toEqual(comparable(before));
    const suffix = o.append(bob, o.join(carol, 12));
    const after = ok(Ledger.extendLedger(imported, [suffix], checkpoint(o.records)));
    expect(comparable(after)).toEqual(comparable(ok(o.verify())));
    expect(comparable(imported)).toEqual(comparable(before));
  });
  it('rejects an Admin-signed impossible Owner state: old failure/new pass', () => {
    const o = org();
    o.append(owner, o.join(bob, 11));
    o.append(owner, [3, id(11), 1]);
    const view = ok(o.verify());
    const forged = editedSnapshot(view, bob, (body) => {
      const state = body[5] as CborValue[];
      const rows = stateRows(state);
      deviceRow(rows, owner)[69] = 0; // the Owner's only device, retired
      setStateRows(state, rows);
    });
    expect(code(Snapshots.verifyLedgerSnapshot(forged))).toBe('unauthorized');
    expect(comparable(view)).toEqual(comparable(ok(o.verify())));
  });
  it('requires external contact trust after a journal/snapshot substitutes an attacker', () => {
    const o = org();
    const view = ok(o.verify());
    const honest = endorsed(view);
    const forged = editedSnapshot(view, owner, (body) => {
      body[4] = attacker.pk;
      const state = body[5] as CborValue[];
      const rows = stateRows(state);
      rows[1]![0]!.set(attacker.pk, 0);
      setStateRows(state, rows);
    });
    const root = ok(decodeSnapshotCbor(forged.snapshot)) as CborValue[];
    const bodyBytes = ok(encodeSnapshotCbor(root[0]!));
    const attack = ok(
      Snapshots.encodeSignedSnapshot(
        bodyBytes,
        ok(Bytes.signature(attacker.sign(Snapshots.snapshotSigningBytes(bodyBytes))))
      )
    );
    const selfClaimedJournal = {
      endorser: ok(Bytes.signingPublicKey(attacker.pk)),
      headSignature: ok(
        Bytes.signature(
          attacker.sign(Snapshots.headAttestationSigningBytes(view.genesis, view.head))
        )
      ),
    };
    expect(
      code(
        Snapshots.verifyLedgerSnapshot({
          snapshot: attack,
          trust: honest.trust,
          ...{ journal: selfClaimedJournal },
        })
      )
    ).toBe('unauthorized');
  });
  it('checks real signatures even if an extra always-success verifier is supplied', () => {
    const o = org();
    const view = ok(o.verify());
    const data = endorsed(view);
    const root = ok(decodeSnapshotCbor(data.snapshot)) as CborValue[];
    root[1] = filled(0, 64);
    const snapshot = ok(encodeSnapshotCbor(root));
    expect(
      code(
        Snapshots.verifyLedgerSnapshot({
          ...data,
          snapshot,
          ...{ verifier: { verify: () => true } },
        })
      )
    ).toBe('bad-signature');
    o.append(owner, [7, 1, filled(50), filled(3, 72)], filled(0, 64));
    expect(
      code(
        Ledger.verifyLedger({
          records: o.records,
          anchor: o.anchor,
          checkpoint: checkpoint(o.records),
          ...{ verifier: { verify: () => true } },
        })
      )
    ).toBe('bad-signature');
  });
  it('does not mint authority from reflected, structural or independently decoded state', () => {
    const o = org();
    const view = ok(o.verify());
    expect((view as unknown as { constructor: unknown }).constructor).toBeUndefined();
    const counterfeit = {
      ...view,
      inspectState: () => ({ ...view.inspectState(), owner: ok(Bytes.membershipId(id(99))) }),
    };
    expect(
      code(Snapshots.prepareLedgerSnapshot(counterfeit, ok(Bytes.signingPublicKey(owner.pk))))
    ).toBe('unauthorized');
    expect(code(Snapshots.comparisonNote(counterfeit, ok(Bytes.signingPublicKey(owner.pk))))).toBe(
      'unauthorized'
    );
    expect(code(Snapshots.ledgerStateDigest(counterfeit))).toBe('unauthorized');
    expect(
      code(Snapshots.historicalContentIdentity(counterfeit, ok(Bytes.signingPublicKey(owner.pk))))
    ).toBe('unauthorized');
  });
  it('rejects changed state, wrong head/count/genesis, signer and invalid suffix without changing the previous view', () => {
    const o = org();
    o.append(owner, o.join(bob, 11));
    const view = ok(o.verify());
    const data = endorsed(view);
    const root = ok(decodeSnapshotCbor(data.snapshot)) as CborValue[][];
    const auth = root[0]![5] as CborValue[];
    auth[5] = true;
    expect(
      code(Snapshots.verifyLedgerSnapshot({ ...data, snapshot: ok(encodeSnapshotCbor(root)) }))
    ).toBe('bad-signature');
    // Validly signed bodies of another version (1 was the pre-compact layout) are rejected.
    expect((ok(decodeSnapshotCbor(data.proposal.bodyBytes)) as CborValue[])[0]).toBe(3);
    for (const version of [1, 2, 4])
      expect(
        code(
          Snapshots.verifyLedgerSnapshot(
            editedSnapshot(view, owner, (body) => {
              body[0] = version;
            })
          )
        )
      ).toBe('unknown-version');
    expect(
      code(
        Snapshots.verifyLedgerSnapshot({
          ...data,
          trust: { ...data.trust, length: data.trust.length + 1 },
        })
      )
    ).toBe('checkpoint-mismatch');
    expect(
      code(
        Snapshots.verifyLedgerSnapshot({
          ...data,
          trust: { ...data.trust, head: ok(Bytes.recordHash(filled(99))) },
        })
      )
    ).toBe('checkpoint-mismatch');
    expect(
      code(
        Snapshots.verifyLedgerSnapshot({
          ...data,
          trust: { ...data.trust, genesis: ok(Bytes.genesisHash(filled(99))) },
        })
      )
    ).toBe('wrong-anchor');
    expect(
      code(
        Snapshots.verifyLedgerSnapshot({
          ...data,
          trust: { ...data.trust, endorser: ok(Bytes.signingPublicKey(attacker.pk)) },
        })
      )
    ).toBe('unauthorized');
    const imported = ok(Snapshots.verifyLedgerSnapshot(data));
    const invalid = o.append(attacker, [3, id(11), 1]);
    expect(code(Ledger.extendLedger(imported, [invalid], checkpoint(o.records)))).toBe(
      'unauthorized'
    );
    expect(comparable(imported)).toEqual(comparable(view));
  });
  it('preserves revoked authors and their original membership, also through an endorsed snapshot', () => {
    const o = org();
    o.append(owner, o.join(bob, 11));
    o.append(bob, o.device(phone, 0, id(11)));
    o.append(bob, [5, phone.pk]);
    const view = ok(o.verify());
    const key = ok(Bytes.signingPublicKey(phone.pk));
    const identity = ok(Snapshots.historicalContentIdentity(view, key));
    expect(identity.kind).toBe('member');
    if (identity.kind === 'member') {
      expect(hex(identity.actor)).toBe(keyId(filled(11)));
      expect(hex(identity.memberInstance)).toBe(keyId(id(11)));
    }
    const imported = ok(Snapshots.verifyLedgerSnapshot(endorsed(view)));
    const fromSnapshot = ok(Snapshots.historicalContentIdentity(imported, key));
    expect(fromSnapshot.kind).toBe('member');
    expect(hex(fromSnapshot.actor)).toBe(keyId(filled(11)));
    expect(hex(fromSnapshot.memberInstance)).toBe(keyId(id(11)));
    expect(
      code(Snapshots.historicalContentIdentity(imported, ok(Bytes.signingPublicKey(attacker.pk))))
    ).toBe('unauthorized');
  });

  it('separates raw comparison from independently confirmed exact tuples and blocks signer relabel', () => {
    const o = org();
    o.append(owner, o.join(bob, 11));
    const view = ok(o.verify()),
      ownerKey = ok(Bytes.signingPublicKey(owner.pk)),
      bobKey = ok(Bytes.signingPublicKey(bob.pk));
    const local = ok(Snapshots.comparisonNote(view, ownerKey)),
      remote = ok(Snapshots.comparisonNote(view, bobKey));
    expect(ok(Snapshots.compareNotes(local, remote))).toMatchObject({
      kind: 'agree',
      independent: false,
    });
    expect(
      ok(
        Snapshots.confirmIndependentComparison(local, remote, ownerKey, {
          source: 'manual',
          expected: remote,
        })
      )
    ).toMatchObject({ kind: 'agree', independent: true, confirmationSource: 'manual' });
    const relabeled = { ...local, noteSigner: bobKey };
    expect(ok(Snapshots.compareNotes(local, relabeled))).toMatchObject({
      kind: 'agree',
      independent: false,
    });
    expect(
      code(
        Snapshots.confirmIndependentComparison(local, relabeled, ownerKey, {
          source: 'authenticated-channel',
          expected: local,
        })
      )
    ).toBe('unauthorized');
    for (const expected of [
      { ...remote, genesis: ok(Bytes.genesisHash(filled(9))) },
      { ...remote, head: ok(Bytes.recordHash(filled(9))) },
      { ...remote, length: remote.length + 1 },
      { ...remote, stateDigest: ok(Bytes.recordHash(filled(9))) },
      { ...remote, noteSigner: ownerKey },
    ])
      expect(
        code(
          Snapshots.confirmIndependentComparison(local, remote, ownerKey, {
            source: 'manual',
            expected,
          })
        )
      ).toBe('unauthorized');
    expect(
      ok(
        Snapshots.confirmIndependentComparison(remote, local, ownerKey, {
          source: 'manual',
          expected: local,
        })
      )
    ).toMatchObject({ independent: false });
    expect(
      ok(
        Snapshots.compareNotes(local, { ...remote, stateDigest: ok(Bytes.recordHash(filled(88))) })
      )
    ).toMatchObject({ kind: 'conflict' });
    const earlier = ok(Snapshots.comparisonNote(ok(org().verify()), ownerKey));
    expect(ok(Snapshots.compareNotes(local, earlier))).toMatchObject({ kind: 'pending-sync' });
    expect(view.verification).toBe('full-history');
  });
  it('requires explicit external role facts; signature-only evidence cannot become authority', () => {
    const o = org();
    o.append(owner, o.join(bob, 11));
    const view = ok(o.verify()),
      data = endorsed(view);
    const { source, membershipId, role, kind, ...identityOnly } = data.trust;
    expect(source).toBe('external-confirmation');
    expect(kind).toBe('personal');
    expect(role).toBe('owner');
    expect(membershipId.equals(view.inspectState().owner)).toBe(true);
    expect(
      Result.isFailure(
        Snapshots.verifyLedgerSnapshot({ ...data, trust: identityOnly as Snapshots.SnapshotTrust })
      )
    ).toBe(true);
    const evidence = ok(Snapshots.authenticateLedgerSnapshotEvidence(data.snapshot, identityOnly));
    expect(evidence.stage).toBe('signature-evidence');
    expect(
      code(
        Ledger.contentPermissions(
          evidence as unknown as Ledger.LedgerView,
          ok(Bytes.signingPublicKey(owner.pk))
        )
      )
    ).toBe('unauthorized');
    for (const trust of [
      { ...data.trust, membershipId: ok(Bytes.membershipId(id(11))) },
      { ...data.trust, role: 'admin' as const },
      { ...data.trust, kind: 'machine' as unknown as 'personal' },
    ])
      expect(code(Snapshots.verifyLedgerSnapshot({ ...data, trust }))).toBe('unauthorized');
    expect(
      code(
        Snapshots.verifyLedgerSnapshot({
          ...data,
          trust: { ...data.trust, stateDigest: ok(Bytes.recordHash(filled(99))) },
        })
      )
    ).toBe('checkpoint-mismatch');
  });
  it('derives same-position trust only from genuine management views and rejects changed full state', () => {
    const o = org();
    o.append(owner, o.join(bob, 11));
    const view = ok(o.verify()),
      data = endorsed(view);
    const key = ok(Bytes.signingPublicKey(owner.pk));
    const pin = ok(Snapshots.snapshotTrustFromView(view, key, data.trust.headSignature));
    expect(ok(Snapshots.verifyLedgerSnapshot({ ...data, trust: pin }))).toBe(view);
    expect(code(Snapshots.verifyLedgerSnapshot({ ...data, trust: { ...pin } }))).toBe(
      'unauthorized'
    );
    expect(code(Snapshots.snapshotTrustFromView({ ...view }, key, data.trust.headSignature))).toBe(
      'unauthorized'
    );
    expect(
      code(
        Snapshots.snapshotTrustFromView(
          view,
          ok(Bytes.signingPublicKey(bob.pk)),
          data.trust.headSignature
        )
      )
    ).toBe('unauthorized');
    const changed = editedSnapshot(view, owner, (body) => {
      const fields = body[5] as CborValue[];
      fields[5] = true;
    });
    expect(code(Snapshots.verifyLedgerSnapshot({ ...changed, trust: pin }))).toBe(
      'checkpoint-mismatch'
    );
    expect(comparable(view)).toEqual(comparable(ok(o.verify())));
  });
  it('compares endorsed snapshots at their actual count and reports same-position state conflict', () => {
    const o = org();
    const compareAtPoint = (fullView: Ledger.LedgerView, endorsedView: Ledger.LedgerView) => {
      const manager = ok(Bytes.signingPublicKey(owner.pk));
      const a = ok(Snapshots.comparisonNote(endorsedView, manager));
      const b = ok(Snapshots.comparisonNote(fullView, manager));
      expect(a.length).toBe(fullView.length);
      expect(b.length).toBe(fullView.length);
      expect(a.head.equals(b.head)).toBe(true);
      expect(a.stateDigest.equals(b.stateDigest)).toBe(true);
      for (const [left, right] of [
        [a, b],
        [b, a],
      ] as const) {
        expect(ok(Snapshots.compareNotes(left, right))).toMatchObject({
          kind: 'agree',
          length: fullView.length,
          independent: false,
        });
        // Independently selected tuple; bytes never prove peer authentication.
        expect(
          ok(
            Snapshots.confirmIndependentComparison(left, right, manager, {
              source: 'authenticated-channel',
              expected: right,
            })
          )
        ).toMatchObject({ kind: 'agree', length: fullView.length });
      }
    };
    const conflictAtPoint = (fullView: Ledger.LedgerView) => {
      const manager = ok(Bytes.signingPublicKey(owner.pk));
      const changed = editedSnapshot(fullView, owner, (body) => {
        const state = body[5] as CborValue[];
        // Qualified malicious endorsement changes a well-formed commitment,
        // retaining OwnerGov and genesis-count constraints, not proving a preimage.
        const rows = stateRows(state);
        rows[3]![rows[3]!.length - 1] = filled(66);
        setStateRows(state, rows);
      });
      const importedView = ok(Snapshots.verifyLedgerSnapshot(changed));
      const a = ok(Snapshots.comparisonNote(fullView, manager));
      const b = ok(Snapshots.comparisonNote(importedView, manager));
      expect(a.head.equals(b.head)).toBe(true);
      expect(a.length).toBe(b.length);
      expect(a.stateDigest.equals(b.stateDigest)).toBe(false);
      for (const [left, right] of [
        [a, b],
        [b, a],
      ] as const) {
        expect(ok(Snapshots.compareNotes(left, right))).toMatchObject({
          kind: 'conflict',
          length: fullView.length,
        });
        expect(
          ok(
            Snapshots.confirmIndependentComparison(left, right, manager, {
              source: 'manual',
              expected: right,
            })
          )
        ).toMatchObject({ kind: 'conflict', length: fullView.length });
      }
    };
    const zero = ok(o.verify());
    const zeroImported = ok(Snapshots.verifyLedgerSnapshot(endorsed(zero)));
    expect(zeroImported.historyStart).toBe(0);
    compareAtPoint(zero, zeroImported);
    conflictAtPoint(zero);
    const zeroSuffix = o.append(owner, o.join(bob, 11));
    const zeroAdvanced = ok(Ledger.extendLedger(zeroImported, [zeroSuffix], checkpoint(o.records)));
    expect(zeroAdvanced.historyStart).toBe(0);
    compareAtPoint(ok(o.verify()), zeroAdvanced);
    o.append(owner, [3, id(11), 1]);
    const full = ok(o.verify()),
      imported = ok(Snapshots.verifyLedgerSnapshot(endorsed(full)));
    expect(imported.historyStart).toBe(2);
    compareAtPoint(full, imported);
    const local = ok(Snapshots.comparisonNote(imported, ok(Bytes.signingPublicKey(owner.pk))));
    const remote = ok(Snapshots.comparisonNote(full, ok(Bytes.signingPublicKey(bob.pk))));
    expect(imported.length).toBe(3);
    expect(local.length).toBe(imported.length);
    expect(ok(Snapshots.compareNotes(local, remote))).toMatchObject({
      kind: 'agree',
      independent: false,
    });
    expect(
      ok(
        Snapshots.confirmIndependentComparison(
          local,
          remote,
          ok(Bytes.signingPublicKey(owner.pk)),
          { source: 'authenticated-channel', expected: remote }
        )
      )
    ).toMatchObject({ kind: 'agree', independent: true });
    const changed = editedSnapshot(full, owner, (body) => {
      (body[5] as CborValue[])[5] = true;
    });
    const contrary = ok(
      Snapshots.comparisonNote(
        ok(Snapshots.verifyLedgerSnapshot(changed)),
        ok(Bytes.signingPublicKey(owner.pk))
      )
    );
    expect(contrary.head.equals(remote.head)).toBe(true);
    expect(contrary.length).toBe(remote.length);
    expect(contrary.stateDigest.equals(remote.stateDigest)).toBe(false);
    for (const [left, right] of [
      [remote, contrary],
      [contrary, remote],
    ] as const) {
      expect(ok(Snapshots.compareNotes(left, right))).toMatchObject({
        kind: 'conflict',
        length: full.length,
      });
      expect(
        ok(
          Snapshots.confirmIndependentComparison(
            left,
            right,
            ok(Bytes.signingPublicKey(owner.pk)),
            {
              source: 'authenticated-channel',
              expected: right,
            }
          )
        )
      ).toMatchObject({ kind: 'conflict', length: full.length });
    }
    const suffix = o.append(owner, [7, 1, filled(21), filled(22, 72)]);
    const extended = ok(Ledger.extendLedger(imported, [suffix], checkpoint(o.records)));
    expect(
      ok(Snapshots.comparisonNote(extended, ok(Bytes.signingPublicKey(owner.pk)))).length
    ).toBe(4);
    expect(extended.historyStart).toBe(2);
    compareAtPoint(ok(o.verify()), extended);
    conflictAtPoint(ok(o.verify()));
    expect(
      ok(
        Snapshots.compareNotes(
          local,
          ok(Snapshots.comparisonNote(extended, ok(Bytes.signingPublicKey(bob.pk))))
        )
      )
    ).toMatchObject({ kind: 'pending-sync' });
  });
  it('tracks actual verified suffix hashes, supports large pinned counts and never invents a prefix', () => {
    const o = org(),
      genesis = ok(o.verify());
    o.append(owner, o.device(phone, 0));
    const view = ok(o.verify()),
      data = endorsed(view),
      imported = ok(Snapshots.verifyLedgerSnapshot(data));
    expect(imported.verification).toBe('endorsed-snapshot');
    expect(imported.historyStart).toBe(1);
    expect(imported.length).toBe(2);
    expect(Result.isFailure(Ledger.requireLedgerContinuation(genesis, imported))).toBe(true);
    expect(Result.isSuccess(Ledger.requireLedgerContinuation(view, imported))).toBe(true);
    const suffix = o.append(owner, [7, 1, filled(21), filled(22, 72)]);
    const extended = ok(Ledger.extendLedger(imported, [suffix], checkpoint(o.records)));
    expect(extended.length).toBe(3);
    expect(extended.historyStart).toBe(1);
    expect(Result.isSuccess(Ledger.requireLedgerContinuation(imported, extended))).toBe(true);
    const longer = org();
    longer.append(owner, longer.join(bob, 11));
    longer.append(owner, [3, id(11), 1]);
    const large = editedSnapshot(ok(longer.verify()), owner, (body) => {
      body[2] = 1_000_000;
    });
    const high = ok(
      Snapshots.verifyLedgerSnapshot({ ...large, trust: { ...large.trust, length: 1_000_000 } })
    );
    expect(high.length).toBe(1_000_000);
    expect(high.historyStart).toBe(999_999);
    const proposed = ok(
      Snapshots.prepareLedgerSnapshot(high, ok(Bytes.signingPublicKey(owner.pk)))
    );
    const body = ok(decodeSnapshotCbor(proposed.bodyBytes)) as CborValue[];
    expect(body[2]).toBe(1_000_000);
  });
  it('bounds snapshot expansion and keeps canonical constraints independent of record budgets', () => {
    const shared = Array.from({ length: 16384 }, () => filled(1, 256));
    expect(Result.isFailure(encodeSnapshotCbor(shared))).toBe(true);
    const cycle: CborValue[] = [];
    cycle.push(cycle);
    expect(Result.isFailure(encodeSnapshotCbor(cycle))).toBe(true);
    expect(Result.isFailure(encodeSnapshotCbor(new Array(16385).fill(null)))).toBe(true);
    const o = org(),
      data = endorsed(ok(o.verify()));
    expect(
      code(
        Snapshots.verifyLedgerSnapshot({ ...data, snapshot: new Uint8Array(2 * 1024 * 1024 + 1) })
      )
    ).toBe('oversize');
    expect(Result.isFailure(encodeCbor(Array.from({ length: 33 }, () => null)))).toBe(true);
  });
  it('signs an actual management snapshot via borrowed signer and rejects in-flight loss of management rights', async () => {
    const o = org();
    o.append(owner, o.join(bob, 11));
    o.append(owner, [3, id(11), 1]);
    const device: DeviceSigner = {
      publicKey: ok(Bytes.signingPublicKey(bob.pk)),
      sign: (message) => Effect.sync(() => ok(Bytes.signature(bob.sign(message)))),
    };
    const produced = await Effect.runPromise(
      Snapshots.signLedgerSnapshot({
        signer: device,
        ledger: () => Effect.sync(() => ok(o.verify())),
      })
    );
    const data = endorsed(ok(o.verify()), bob);
    expect(produced.snapshot).toEqual(data.snapshot);
    expect(produced.headSignature.toBytes()).toEqual(data.trust.headSignature.toBytes());
    let moved = false;
    const revoked: DeviceSigner = {
      ...device,
      sign: (message) =>
        Effect.sync(() => {
          if (!moved) {
            moved = true;
            o.append(owner, [3, id(11), 2]);
          }
          return ok(Bytes.signature(bob.sign(message)));
        }),
    };
    const failed = await Effect.runPromise(
      Effect.result(
        Snapshots.signLedgerSnapshot({
          signer: revoked,
          ledger: () => Effect.sync(() => ok(o.verify())),
        })
      )
    );
    expect(Result.isFailure(failed)).toBe(true);
    expect(
      ok(o.verify())
        .inspectState()
        .members.get(keyId(id(11)))!.role
    ).toBe('member');
  });
  it('tracks current member users: a removed user may rejoin, a current one never twice, also after import', () => {
    const o = org();
    o.append(owner, o.join(bob, 11));
    const rejoin = o.join(carol, 11); // same user as bob, fresh keys and request
    const withBob = ok(o.verify());
    const duplicate = o.append(owner, [1, id(12), rejoin[2]]);
    expect(code(o.verify())).toBe('replay');
    const imported = ok(Snapshots.verifyLedgerSnapshot(endorsed(withBob)));
    expect(code(Ledger.extendLedger(imported, [duplicate], checkpoint(o.records)))).toBe('replay');

    const removed = org();
    removed.append(owner, removed.join(bob, 11));
    removed.append(owner, [8, id(11), 1, filled(21), filled(30, 72)]);
    removed.append(owner, [1, id(12), removed.join(carol, 11)[2]]);
    expect(code(removed.verify())).toBe('accepted');
  });

  it('retains replay prevention after endorsement import and rejects malformed complete-state facts', () => {
    const o = org();
    o.append(owner, o.join(bob, 11));
    o.append(bob, o.device(phone, 0, id(11)));
    o.append(bob, [5, phone.pk]);
    const before = ok(o.verify()),
      imported = ok(Snapshots.verifyLedgerSnapshot(endorsed(before))),
      retry = o.append(bob, o.device(phone, 0, id(11)));
    expect(code(Ledger.extendLedger(imported, [retry], checkpoint(o.records)))).toBe('replay');
    const retiredIdentity = ok(
      Snapshots.historicalContentIdentity(imported, ok(Bytes.signingPublicKey(phone.pk)))
    );
    expect(hex(retiredIdentity.actor)).toBe(keyId(filled(11)));
    expect(hex(retiredIdentity.memberInstance)).toBe(keyId(id(11)));
    const clean = org(),
      view = ok(clean.verify());
    const tables = (change: (rows: Uint8Array[][]) => void) => (state: CborValue[]) => {
      const rows = stateRows(state);
      change(rows);
      setStateRows(state, rows);
    };
    for (const edit of [
      // Shape: field count, types and row widths.
      (state: CborValue[]) => void state.push(true),
      (state: CborValue[]) => void (state[0] = []),
      (state: CborValue[]) => void (state[5] = 1),
      (state: CborValue[]) => void (state[1] = (state[1] as Uint8Array).subarray(1)),
      // Every table must hold what the ledger grammar requires.
      tables((rows) => void (rows[0] = [])),
      tables((rows) => void (rows[1] = [])),
      tables((rows) => void (rows[3] = [])),
      tables((rows) => void rows[4]!.push(filled(9, 72))),
      tables((rows) => void rows[2]!.push(filled(0, 20))),
      // Order and uniqueness.
      tables((rows) => void rows[0]!.push(rows[0]![0]!)),
      tables((rows) => void rows[1]!.push(rows[1]![0]!)),
      tables((rows) => void rows[3]!.push(rows[3]![0]!)),
      // Out-of-range codes and references.
      tables((rows) => void (rows[0]![0]![48] = 9)),
      tables((rows) => void (rows[0]![0]![48] = 2)), // no Owner left
      tables((rows) => void (rows[1]![0]![68] = 9)),
      tables((rows) => void (rows[1]![0]![67] = 1)), // membership index 1 of 1
      // A genesis-length state is the genesis shape.
      (state: CborValue[]) => void (state[5] = true),
    ]) {
      const data = editedSnapshot(view, owner, (body) => edit(body[5] as CborValue[]));
      // Every edit stays signed by a qualified endorser; only the state is malformed.
      expect(Result.isFailure(Snapshots.verifyLedgerSnapshot(data))).toBe(true);
    }
    expect(comparable(view)).toEqual(comparable(ok(clean.verify())));
  });
  it('authenticates endorsed history to real commitments and scoped installation without claiming a full audit', async () => {
    const f = envelopeFixture(),
      next = ok(Bytes.epochKey(filled(19))),
      commitment = ok(EpochKeys.commitEpochKey(f.context.genesis, 1, next));
    const packet = ok(
      EpochKeys.sealHistoryPacket({
        genesis: f.context.genesis,
        epoch: 1,
        currentKey: next,
        previousKey: f.secret,
      })
    );
    f.append([7, 1, commitment.toBytes(), packet]);
    const packaged = await Effect.runPromise(
      Snapshots.signLedgerSnapshot({ signer: f.owner.signer, ledger: f.ledger })
    );
    const view = ok(
      Snapshots.verifyLedgerSnapshot({
        snapshot: packaged.snapshot,
        trust: {
          source: 'external-confirmation',
          genesis: f.context.genesis,
          endorser: f.owner.publicKey,
          membershipId: ok(Bytes.membershipId(id(10))),
          role: 'owner',
          kind: 'personal',
          head: packaged.head,
          length: packaged.length,
          headSignature: packaged.headSignature,
        },
      })
    );
    const recovered = ok(EpochKeys.recoverLedgerHistory(view, next));
    expect(recovered.size).toBe(2);
    expect(view.verification).toBe('endorsed-snapshot');
    expect(ok(EpochKeys.commitEpochKey(view.genesis, 0, recovered.get(0)!)).toBytes()).toEqual(
      ok(Ledger.epochHistoryPacket(view, 0)).commitment.toBytes()
    );
    for (const [epoch, key] of recovered)
      expect(ok(EpochKeys.commitEpochKey(view.genesis, epoch, key))).toEqual(
        ok(Ledger.epochHistoryPacket(view, epoch)).commitment
      );
  });
});

describe('public admission consent and ordinary intent', () => {
  const signerFor = (device: Keys): DeviceSigner => ({
    publicKey: ok(Bytes.signingPublicKey(device.pk)),
    sign: (message) => Effect.sync(() => ok(Bytes.signature(device.sign(message)))),
  });
  const genesisInput = () => ({
    userId: ok(Bytes.userId(filled(10))),
    membershipId: ok(Bytes.membershipId(id(10))),
    encryptionPublicKey: ok(Bytes.encryptionPublicKey(owner.enc)),
    initialKey: ok(Bytes.epochKey(filled(7))),
    signer: signerFor(owner),
  });
  it('produces exact independently signed v1 genesis with the known epoch-zero commitment', async () => {
    const produced = await Effect.runPromise(Admission.signGenesisRecord(genesisInput()));
    const commitment = new Uint8Array(
      Buffer.from('a3aef9534598636f0eae326672b9710bc84d0e3627062491026d681df37e6f14', 'hex')
    );
    const expected = signed([1, owner.pk, filled(10), id(10), owner.enc, commitment], owner);
    expect(produced.record).toEqual(expected);
    const view = ok(
      Ledger.verifyLedger({
        anchor: produced.genesis,
        records: [produced.record],
        checkpoint: { head: Ledger.hashRecordBytes(produced.record), length: 1 },
      })
    );
    expect(view.inspectState().owner.toBytes()).toEqual(id(10));
    expect(view.inspectState().epoch.keyCommitment.toBytes()).toEqual(commitment);
    expect(
      ok(Ledger.contentPermissions(view, ok(Bytes.signingPublicKey(owner.pk)))).maySealNewContent
    ).toBe(true);
    const tampered = new Uint8Array(produced.record);
    tampered[tampered.length - 1] ^= 1;
    expect(
      Result.isFailure(
        Ledger.verifyLedger({
          anchor: produced.genesis,
          records: [tampered],
          checkpoint: { head: Ledger.hashRecordBytes(tampered), length: 1 },
        })
      )
    ).toBe(true);
  });
  it('rejects fake initial key and malformed signer output rather than producing a genesis', async () => {
    const first = await Effect.runPromise(
      Effect.result(
        Admission.signGenesisRecord({ ...genesisInput(), initialKey: {} as Bytes.EpochKey })
      )
    );
    expect(Result.isFailure(first) && first.failure).toMatchObject({ code: 'invalid-initial-key' });
    const failed = await Effect.runPromise(
      Effect.result(
        Admission.signGenesisRecord({
          ...genesisInput(),
          signer: {
            ...signerFor(owner),
            sign: () => Effect.succeed(ok(Bytes.signature(new Uint8Array(64)))),
          },
        })
      )
    );
    expect(Result.isFailure(failed) && failed.failure).toMatchObject({ code: 'bad-signature' });
  });
  it('signs joining consent and admits the real requester through existing permission/proof verification', async () => {
    const o = org(),
      view = ok(o.verify());
    const request = await Effect.runPromise(
      Admission.prepareJoinRequest({
        genesis: o.anchor,
        requestId: ok(Bytes.requestId(id(11))),
        userId: ok(Bytes.userId(filled(11))),
        encryptionPublicKey: ok(Bytes.encryptionPublicKey(bob.enc)),
        expiresAt: null,
        signer: signerFor(bob),
      })
    );
    const prepared = ok(
      Admission.prepareLedgerCommand(view, ok(Bytes.signingPublicKey(owner.pk)), {
        _tag: 'AdmitMember',
        membershipId: ok(Bytes.membershipId(id(11))),
        request,
      })
    );
    const record = await Effect.runPromise(Commands.signLedgerRecord(prepared, signerFor(owner)));
    const expected = o.join(bob, 11);
    expect(record).toEqual(signed([view.head.toBytes(), owner.pk, expected], owner));
    const next = ok(
      Ledger.extendLedger(view, [record], { head: Ledger.hashRecordBytes(record), length: 2 })
    );
    expect(next.inspectState().members.has(keyId(id(11)))).toBe(true);
    expect(
      Result.isFailure(
        Admission.prepareLedgerCommand(next, ok(Bytes.signingPublicKey(owner.pk)), {
          _tag: 'AdmitMember',
          membershipId: ok(Bytes.membershipId(id(12))),
          request,
        })
      )
    ).toBe(true);
  });
  it('binds device proof to declared Org, membership and kind and ignores extra retargeting fields', async () => {
    const o = org(),
      view = ok(o.verify());
    const command = await Effect.runPromise(
      Admission.prepareDeviceAdmission({
        genesis: o.anchor,
        membershipId: ok(Bytes.membershipId(id(10))),
        encryptionPublicKey: ok(Bytes.encryptionPublicKey(phone.enc)),
        kind: 'personal',
        signer: signerFor(phone),
        ...{ targetMembershipId: ok(Bytes.membershipId(id(11))), grant: { kind: 'recovery' } },
      })
    );
    const prepare = (input: Admission.LedgerCommand) =>
      Admission.prepareLedgerCommand(view, ok(Bytes.signingPublicKey(owner.pk)), input);
    const record = await Effect.runPromise(
      Commands.signLedgerRecord(ok(prepare(command)), signerFor(owner))
    );
    expect(record).toEqual(signed([view.head.toBytes(), owner.pk, o.device(phone, 0)], owner));
    expect(code(prepare({ ...command, kind: 'machine', machineId: 'machine' }))).toBe('bad-proof');
    const wrong = await Effect.runPromise(
      Admission.prepareDeviceAdmission({
        genesis: o.anchor,
        membershipId: ok(Bytes.membershipId(id(11))),
        encryptionPublicKey: ok(Bytes.encryptionPublicKey(phone.enc)),
        kind: 'personal',
        signer: signerFor(phone),
      })
    );
    expect(code(prepare(wrong))).toBe('bad-proof');
    const different = await Effect.runPromise(
      Admission.prepareDeviceAdmission({
        genesis: ok(Bytes.genesisHash(filled(99))),
        membershipId: ok(Bytes.membershipId(id(10))),
        encryptionPublicKey: ok(Bytes.encryptionPublicKey(phone.enc)),
        kind: 'personal',
        signer: signerFor(phone),
      })
    );
    expect(code(prepare(different))).toBe('bad-proof');
    expect(
      code(
        Admission.prepareLedgerCommand({ ...view }, ok(Bytes.signingPublicKey(owner.pk)), command)
      )
    ).toBe('unauthorized');
  });
  it('keeps proofs fixed when request properties mutate during borrowed async signing', async () => {
    const o = org();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const reached = yield* Deferred.make<void>(),
            release = yield* Deferred.make<void>();
          const delayed: DeviceSigner = {
            publicKey: ok(Bytes.signingPublicKey(phone.pk)),
            sign: (message) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(reached, undefined);
                yield* Deferred.await(release);
                return ok(Bytes.signature(phone.sign(message)));
              }),
          };
          const request = {
            genesis: o.anchor,
            membershipId: ok(Bytes.membershipId(id(10))),
            encryptionPublicKey: ok(Bytes.encryptionPublicKey(phone.enc)),
            kind: 'personal' as Ledger.DeviceKind,
            signer: delayed,
          };
          const worker = yield* Effect.forkChild(Admission.prepareDeviceAdmission(request));
          yield* Deferred.await(reached);
          request.kind = 'recovery';
          request.membershipId = ok(Bytes.membershipId(id(99)));
          request.signer = signerFor(recovery);
          yield* Deferred.succeed(release, undefined);
          const command = yield* Fiber.join(worker);
          expect(command.kind).toBe('personal');
          expect(
            Result.isSuccess(
              Admission.prepareLedgerCommand(
                ok(o.verify()),
                ok(Bytes.signingPublicKey(owner.pk)),
                command
              )
            )
          ).toBe(true);
        })
      )
    );
  });
  it('keeps ordinary intent parent-relative and rejects unauthorized, unknown and obsolete commands', async () => {
    const o = org();
    o.append(owner, o.join(bob, 11));
    const view = ok(o.verify());
    const ownerKey = ok(Bytes.signingPublicKey(owner.pk)),
      member = ok(Bytes.membershipId(id(11)));
    const role = ok(
      Admission.prepareLedgerCommand(view, ownerKey, {
        _tag: 'SetRole',
        membershipId: member,
        role: 'guest',
      })
    );
    const signedRole = await Effect.runPromise(Commands.signLedgerRecord(role, signerFor(owner)));
    const next = ok(
      Ledger.extendLedger(view, [signedRole], {
        head: Ledger.hashRecordBytes(signedRole),
        length: 3,
      })
    );
    expect(next.inspectState().members.get(keyId(id(11)))?.role).toBe('guest');
    expect(
      code(
        Admission.prepareLedgerCommand(next, ok(Bytes.signingPublicKey(bob.pk)), {
          _tag: 'SetRole',
          membershipId: member,
          role: 'admin',
        })
      )
    ).toBe('unauthorized');
    expect(
      code(
        Admission.prepareLedgerCommand(view, ownerKey, {
          _tag: 'RemoveMember',
          membershipId: member,
        } as unknown as Admission.LedgerCommand)
      )
    ).toBe('unknown-operation');
    const transfer = ok(
      Admission.prepareLedgerCommand(view, ownerKey, {
        _tag: 'TransferOwner',
        successorMembershipId: member,
      })
    );
    const transferred = await Effect.runPromise(
      Commands.signLedgerRecord(transfer, signerFor(owner))
    );
    expect(
      ok(
        Ledger.extendLedger(view, [transferred], {
          head: Ledger.hashRecordBytes(transferred),
          length: 3,
        })
      )
        .inspectState()
        .owner.toBytes()
    ).toEqual(id(11));
    expect(
      Result.isFailure(
        Ledger.extendLedger(next, [transferred], {
          head: Ledger.hashRecordBytes(transferred),
          length: 4,
        })
      )
    ).toBe(true);
  });
  it('converts own-device revoke and all settled device kinds through actual ledger policy', async () => {
    for (const [kind, target] of [
      ['personal', phone],
      ['machine', machine],
      ['recovery', recovery],
    ] as const) {
      const o = org(),
        view = ok(o.verify()),
        ownerKey = ok(Bytes.signingPublicKey(owner.pk));
      const command = await Effect.runPromise(
        Admission.prepareDeviceAdmission({
          genesis: o.anchor,
          membershipId: ok(Bytes.membershipId(id(10))),
          encryptionPublicKey: ok(Bytes.encryptionPublicKey(target.enc)),
          kind,
          ...(kind === 'machine'
            ? { machineId: `machine:${Buffer.from(target.pk).toString('hex')}` }
            : {}),
          signer: signerFor(target),
        })
      );
      const record = await Effect.runPromise(
        Commands.signLedgerRecord(
          ok(Admission.prepareLedgerCommand(view, ownerKey, command)),
          signerFor(owner)
        )
      );
      const admitted = ok(
        Ledger.extendLedger(view, [record], { head: Ledger.hashRecordBytes(record), length: 2 })
      );
      expect(admitted.inspectState().devices.get(keyId(target.pk))?.kind).toBe(kind);
      const removal = await Effect.runPromise(
        Commands.signLedgerRecord(
          ok(
            Admission.prepareLedgerCommand(admitted, ownerKey, {
              _tag: 'RevokeDevice',
              target: ok(Bytes.signingPublicKey(target.pk)),
            })
          ),
          signerFor(owner)
        )
      );
      const revoked = ok(
        Ledger.extendLedger(admitted, [removal], {
          head: Ledger.hashRecordBytes(removal),
          length: 3,
        })
      );
      expect(revoked.inspectState().devices.has(keyId(target.pk))).toBe(false);
      expect(
        Result.isFailure(
          Admission.prepareLedgerCommand(revoked, ok(Bytes.signingPublicKey(target.pk)), {
            _tag: 'RevokeDevice',
            target: ownerKey,
          })
        )
      ).toBe(true);
    }
  });
  it('rejects invalid kind/expiry and bad joining signer output with explicit errors', async () => {
    const o = org();
    const device = {
      genesis: o.anchor,
      membershipId: ok(Bytes.membershipId(id(10))),
      encryptionPublicKey: ok(Bytes.encryptionPublicKey(phone.enc)),
      kind: 'unknown' as Ledger.DeviceKind,
      signer: signerFor(phone),
    };
    const invalidKind = await Effect.runPromise(
      Effect.result(Admission.prepareDeviceAdmission(device))
    );
    expect(Result.isFailure(invalidKind) && invalidKind.failure).toMatchObject({
      code: 'canonical',
    });
    const join = {
      genesis: o.anchor,
      requestId: ok(Bytes.requestId(id(11))),
      userId: ok(Bytes.userId(filled(11))),
      encryptionPublicKey: ok(Bytes.encryptionPublicKey(bob.enc)),
      expiresAt: -1,
      signer: signerFor(bob),
    };
    const invalidExpiry = await Effect.runPromise(
      Effect.result(Admission.prepareJoinRequest(join))
    );
    expect(Result.isFailure(invalidExpiry) && invalidExpiry.failure).toMatchObject({
      code: 'canonical',
    });
    const bad = await Effect.runPromise(
      Effect.result(
        Admission.prepareJoinRequest({
          ...join,
          expiresAt: null,
          signer: {
            ...join.signer,
            sign: () => Effect.succeed(ok(Bytes.signature(new Uint8Array(64)))),
          },
        })
      )
    );
    expect(Result.isFailure(bad) && bad.failure).toMatchObject({ code: 'bad-signature' });
  });
});

describe('retained verified state', () => {
  const publicKey = (key: Keys) => ok(Bytes.signingPublicKey(key.pk));
  function history() {
    const o = org();
    o.append(owner, o.join(bob, 11));
    o.append(owner, [3, id(11), 1]);
    o.append(owner, o.device(phone, 0));
    o.append(bob, [7, 1, filled(21), filled(31, 72)]);
    o.append(owner, [5, phone.pk]);
    o.append(owner, [8, id(11), 2, filled(22), filled(32, 72)]);
    o.append(owner, o.join(carol, 12));
    return o;
  }
  const prefix = (o: ReturnType<typeof org>, length: number) =>
    ok(
      Ledger.verifyLedger({
        anchor: o.anchor,
        records: o.records.slice(0, length),
        checkpoint: checkpoint(o.records.slice(0, length)),
      })
    );

  it('restores at every position and extends to exactly the full replay', () => {
    const o = history(),
      full = ok(o.verify()),
      exported = ok(Ledger.exportVerifiedState(full));
    expect(hex(exported.stateDigest)).toBe(
      hex(ok(Snapshots.comparisonNote(full, publicKey(owner))).stateDigest)
    );
    for (let length = 1; length < o.records.length; length++) {
      const saved = ok(Ledger.exportVerifiedState(prefix(o, length)));
      const restored = ok(Ledger.restoreVerifiedState(saved));
      expect(restored).toMatchObject({ length, historyStart: length - 1 });
      expect(restored.verification).toBe('full-history');
      const extended = ok(
        Ledger.extendLedger(restored, o.records.slice(length), checkpoint(o.records))
      );
      expect(comparable(extended)).toEqual(comparable(full));
      const again = ok(Ledger.exportVerifiedState(extended));
      expect(again.bytes).toEqual(exported.bytes);
      expect(hex(again.stateDigest)).toBe(hex(exported.stateDigest));
    }
  });

  it('keeps every replay fact: used keys, closed joins, users and commitments', () => {
    const o = history(),
      restored = ok(Ledger.restoreVerifiedState(ok(Ledger.exportVerifiedState(ok(o.verify())))));
    const attempts: readonly (readonly CborValue[])[] = [
      o.device(phone, 0), // revoked signing key
      o.join(bob, 11), // removed membership ID and closed join
      [1, id(13), o.join(carol, 13)[2]], // carol's request again
      [1, id(14), o.join(keys(14), 12)[2]], // carol's user while she is a member
      [7, 3, filled(21), filled(33, 72)], // reused epoch commitment
    ];
    for (const op of attempts) {
      const record = signed([restored.head.toBytes(), owner.pk, op], owner);
      expect(
        code(Ledger.extendLedger(restored, [record], checkpoint([...o.records, record])))
      ).toBe('replay');
    }
  });

  it('fails closed on a forked continuation and on bytes that do not match the stored position', () => {
    const o = history(),
      saved = ok(Ledger.exportVerifiedState(prefix(o, 4))),
      restored = ok(Ledger.restoreVerifiedState(saved));
    const parent = Ledger.hashRecordBytes(o.records[2]!).toBytes(),
      fork = signed([parent, owner.pk, [3, id(11), 2]], owner);
    expect(
      code(Ledger.extendLedger(restored, [fork], { head: Ledger.hashRecordBytes(fork), length: 5 }))
    ).toBe('wrong-parent');

    const other = ok(Ledger.exportVerifiedState(prefix(o, 5)));
    expect(code(Ledger.restoreVerifiedState({ ...saved, head: other.head }))).toBe(
      'checkpoint-mismatch'
    );
    expect(code(Ledger.restoreVerifiedState({ ...saved, length: 5 }))).toBe('checkpoint-mismatch');
    expect(code(Ledger.restoreVerifiedState({ ...other, bytes: saved.bytes }))).toBe(
      'checkpoint-mismatch'
    );
    const elsewhere = ok(Bytes.genesisHash(filled(9)));
    expect(code(Ledger.restoreVerifiedState({ ...saved, genesis: elsewhere }))).toBe(
      'wrong-anchor'
    );
    expect(
      code(Ledger.restoreVerifiedState({ ...saved, bytes: saved.bytes.subarray(0, 40) }))
    ).not.toBe('accepted');
    // Current-only: a row written before version 2 (or by a newer client) is rebuilt by full replay.
    for (const version of [1, 2, 4]) {
      const stale = new Uint8Array(saved.bytes);
      expect(stale[1]).toBe(3);
      stale[1] = version;
      expect(code(Ledger.restoreVerifiedState({ ...saved, bytes: stale }))).toBe('unknown-version');
    }
  });

  it('checks the stored state digest when the caller supplies it', () => {
    const o = history(),
      full = ok(o.verify()),
      saved = ok(Ledger.exportVerifiedState(full));
    // The digest is the comparison-note digest, recomputed from the retained bytes alone.
    expect(hex(saved.stateDigest)).toBe(hex(ok(Snapshots.ledgerStateDigest(full))));
    expect(comparable(ok(Ledger.restoreVerifiedState(saved)))).toEqual(comparable(full));
    const { stateDigest: _, ...withoutDigest } = saved;
    expect(comparable(ok(Ledger.restoreVerifiedState(withoutDigest)))).toEqual(comparable(full));

    const wrong = ok(Bytes.recordHash(filled(7)));
    expect(code(Ledger.restoreVerifiedState({ ...saved, stateDigest: wrong }))).toBe(
      'state-digest-mismatch'
    );
    // Flipping the provenance byte keeps the bytes decodable but leaves the
    // digest unchanged (provenance is not part of it); a byte inside S does not.
    const provenance = new Uint8Array(saved.bytes);
    provenance[provenance.length - 1] = 1;
    expect(ok(Ledger.restoreVerifiedState({ ...saved, bytes: provenance })).verification).toBe(
      'endorsed-snapshot'
    );
    const earlier = ok(Ledger.exportVerifiedState(prefix(o, 4)));
    expect(code(Ledger.restoreVerifiedState({ ...earlier, stateDigest: saved.stateDigest }))).toBe(
      'state-digest-mismatch'
    );
  });

  it('keeps every author and reports the publications it does not retain as unavailable', () => {
    const o = history(),
      full = ok(o.verify()),
      restored = ok(Ledger.restoreVerifiedState(ok(Ledger.exportVerifiedState(full))));
    for (const key of [owner, bob, phone, carol])
      expect(ok(Snapshots.historicalContentIdentity(restored, publicKey(key)))).toEqual(
        ok(Snapshots.historicalContentIdentity(full, publicKey(key)))
      );
    expect(code(Ledger.epochPublicationRecord(full, 2))).toBe('accepted');
    expect(code(Ledger.epochPublicationRecord(restored, 2))).toBe('unauthorized');
    expect(ok(Ledger.epochHistoryPacket(restored, 2)).packet).toEqual(filled(32, 72));
  });
});

describe('frozen ledger v1 compatibility', () => {
  const fromHex = (value: string) => new Uint8Array(Buffer.from(value, 'hex'));
  const records = ledgerV1.records.map((record) => fromHex(record.hex));
  const anchor = ok(Bytes.genesisHash(fromHex(ledgerV1.anchor)));
  const prefix = (length: number) =>
    Ledger.verifyLedger({
      anchor,
      records: records.slice(0, length),
      checkpoint: checkpoint(records.slice(0, length)),
    });

  it('verifies independently encoded v1 history with unchanged hashes and state', () => {
    // Created outside this codebase; a failure here means existing ledgers stop verifying.
    expect(records.map((record) => hex(Ledger.hashRecordBytes(record)))).toEqual(
      ledgerV1.records.map((record) => record.hash)
    );
    const view = ok(prefix(ledgerV1.expected.verifiedLength));
    const state = comparable(view);
    const expected = ledgerV1.expected;
    expect(state.owner).toBe(expected.owner);
    expect(state.epoch).toEqual(expected.epoch);
    expect(
      Object.fromEntries(state.members.map(([key, userId, role]) => [key, { userId, role }]))
    ).toEqual(expected.members);
    expect(
      Object.fromEntries(
        state.devices.map(([key, membershipId, kind]) => [key, { membershipId, kind }])
      )
    ).toEqual(expected.devices);
    expect(
      Object.fromEntries(
        [...view.inspectState().devices]
          .filter(([, device]) => device.kind === 'machine')
          .map(([key, device]) => [key, device.machineId])
      )
    ).toEqual(expected.machineBindings);
  });

  it('stops at a genuine capability declaration as an upgrade, with its position', () => {
    const all = Ledger.verifyLedger({ anchor, records, checkpoint: checkpoint(records) });
    expect(Result.isFailure(all) && all.failure).toMatchObject(ledgerV1.expected.failure);
    const before = ok(prefix(ledgerV1.expected.verifiedLength));
    const extended = Ledger.extendLedger(before, records.slice(-1), checkpoint(records));
    expect(Result.isFailure(extended) && extended.failure).toMatchObject(ledgerV1.expected.failure);
    expect(before.length).toBe(ledgerV1.expected.verifiedLength);
  });
});

describe('capability declarations', () => {
  it('lets Owner and Admin personal devices declare, and reports an upgrade rather than corruption', () => {
    for (const role of ['owner', 'admin'] as const) {
      const o = org();
      o.append(owner, o.join(bob, 11));
      if (role === 'admin') o.append(owner, [3, id(11), 1]);
      o.append(role === 'owner' ? owner : bob, [9, [1, 7]]);
      const result = o.verify();
      expect(Result.isFailure(result) && result.failure).toMatchObject({
        code: 'upgrade-required',
        position: o.records.length - 1,
      });
    }
  });

  it('rejects declarations by Member, Guest, machine and recovery devices', () => {
    for (const role of ['member', 'guest'] as const) {
      const o = org();
      o.append(owner, o.join(bob, 11));
      if (role === 'guest') o.append(owner, [3, id(11), 3]);
      o.append(bob, [9, [1]]);
      expect(code(o.verify())).toBe('unauthorized');
    }
    for (const kind of [1, 2]) {
      const o = org();
      o.append(owner, o.device(machine, kind));
      o.append(machine, [9, [1]]);
      expect(code(o.verify())).toBe('unauthorized');
    }
  });

  it.each([
    ['empty', []],
    ['zero', [0]],
    ['unsorted', [2, 1]],
    ['duplicate', [1, 1]],
    ['beyond u32', [2 ** 32]],
    ['too many', Array.from({ length: 17 }, (_, index) => index + 1)],
  ])('rejects a %s capability list as invalid', (_, capabilities) => {
    const o = org();
    o.append(owner, [9, capabilities]);
    expect(code(o.verify())).toBe('invalid-operation');
  });
});

describe('compact authorization state', () => {
  const dave = keys(8),
    tablet = keys(9),
    newcomer = keys(12);
  const publicKey = (key: Keys) => ok(Bytes.signingPublicKey(key.pk));
  const everyDevice = [owner, bob, phone, machine, dave, tablet, carol, recovery];
  /** Retired devices, a removed member, a member removed with all its devices,
   * the same user back under a new membership, and several epochs — all before
   * the first export. */
  function lived() {
    const o = org();
    o.append(owner, o.join(bob, 11));
    o.append(bob, o.device(phone, 0, id(11)));
    o.append(bob, o.device(machine, 1, id(11)));
    o.append(bob, [5, phone.pk]);
    o.append(owner, [7, 1, filled(21), filled(31, 72)]);
    o.append(owner, o.join(dave, 13));
    o.append(dave, o.device(tablet, 0, id(13)));
    o.append(owner, [8, id(11), 2, filled(22), filled(32, 72)]);
    o.append(owner, [8, id(13), 3, filled(23), filled(33, 72)]);
    o.append(owner, [1, id(12), o.join(carol, 11)[2]]); // bob's user, new membership
    o.append(owner, o.device(recovery, 2));
    o.append(owner, [7, 4, filled(24), filled(34, 72)]);
    return o;
  }
  const exported = (view: Ledger.LedgerView) => ok(Ledger.exportVerifiedState(view));
  const restored = (view: Ledger.LedgerView) => ok(Ledger.restoreVerifiedState(exported(view)));
  const stateOf = (view: Ledger.LedgerView) =>
    (ok(decodeRetainedCbor(exported(view).bytes)) as CborValue[])[4] as CborValue[];
  const authors = (view: Ledger.LedgerView) =>
    everyDevice.map((key) => {
      const author = ok(Snapshots.historicalContentIdentity(view, publicKey(key)));
      return [hex(author.device), hex(author.actor), hex(author.memberInstance)];
    });
  /** Three sources at one position: full replay, qualified snapshot import, retained restore. */
  function sources(o: ReturnType<typeof org>) {
    const full = ok(o.verify());
    return {
      full,
      snapshot: ok(Snapshots.verifyLedgerSnapshot(endorsed(full))),
      retained: restored(full),
    };
  }

  it('stores each fact once in fixed-width tables', () => {
    const state = stateOf(ok(lived().verify()));
    // 4 memberships, 8 devices, 3 joins, epochs 0..4.
    expect((state.slice(0, 5) as Uint8Array[]).map((table) => table.length)).toEqual([
      4 * 49,
      8 * 70,
      3 * 20,
      5 * 32,
      4 * 72,
    ]);
    expect(state[5]).toBe(false);
  });

  it('gives every source the same state, digest and author of every device ever admitted', () => {
    const o = lived(),
      { full, snapshot, retained } = sources(o),
      digest = hex(ok(Snapshots.ledgerStateDigest(full)));
    for (const view of [snapshot, retained, restored(snapshot)]) {
      expect(comparable(view)).toEqual(comparable(full));
      expect(stateOf(view)).toEqual(stateOf(full));
      expect(hex(ok(Snapshots.ledgerStateDigest(view)))).toBe(digest);
      expect(authors(view)).toEqual(authors(full));
    }
    // The member removed with all its devices still names its user and membership.
    expect(authors(snapshot)[5]).toEqual([keyId(tablet.pk), keyId(filled(13)), keyId(id(13))]);
    // A returning user's old devices stay with the old membership.
    expect(authors(snapshot)[3]![2]).toBe(keyId(id(11)));
    expect(authors(snapshot)[6]![2]).toBe(keyId(id(12)));
  });

  it('accepts and rejects every next record exactly as the full replay does', () => {
    const o = lived(),
      views = sources(o),
      head = views.full.head.toBytes(),
      next = { length: views.full.length + 1 };
    const candidates: [string, readonly CborValue[]][] = [
      ['accepted', o.join(newcomer, 16)],
      ['accepted', [7, 5, filled(25), filled(35, 72)]],
      ['replay', o.device(phone, 0)], // retired signing key
      ['replay', o.device({ ...keys(14), enc: phone.enc }, 0)], // retired encryption key
      ['replay', o.join(keys(15), 11)], // removed membership ID
      ['replay', o.join(keys(17), 13)], // membership removed with all its devices
      ['replay', [1, id(18), o.join(keys(18), 11)[2]]], // current user, second membership
      ['replay', [7, 5, filled(22), filled(35, 72)]], // used commitment
      ['unauthorized', [5, machine.pk]], // retired device is not current
    ];
    for (const [expected, op] of candidates) {
      const record = signed([head, owner.pk, op], owner);
      const check = { head: Ledger.hashRecordBytes(record), length: next.length };
      for (const view of Object.values(views))
        expect([op, code(Ledger.extendLedger(view, [record], check))]).toEqual([op, expected]);
    }
  });

  it('round-trips retained bytes within one source and extends to the same state', () => {
    const o = lived(),
      views = sources(o);
    o.append(owner, o.join(newcomer, 16));
    o.append(newcomer, o.device(keys(19), 0, id(16)));
    o.append(owner, [7, 5, filled(25), filled(35, 72)]);
    const suffix = o.records.slice(views.full.length),
      after = ok(o.verify());
    for (const view of Object.values(views)) {
      const saved = exported(view);
      // Same-source round trip, provenance included.
      expect(exported(ok(Ledger.restoreVerifiedState(saved))).bytes).toEqual(saved.bytes);
      const extended = ok(Ledger.extendLedger(view, suffix, checkpoint(o.records)));
      const resumed = ok(
        Ledger.extendLedger(ok(Ledger.restoreVerifiedState(saved)), suffix, checkpoint(o.records))
      );
      expect(exported(resumed).bytes).toEqual(exported(extended).bytes);
      // Source-independent: the state and digest match the full replay of the longer ledger.
      expect(stateOf(extended)).toEqual(stateOf(after));
      expect(hex(ok(Snapshots.ledgerStateDigest(extended)))).toBe(
        hex(ok(Snapshots.ledgerStateDigest(after)))
      );
      expect(authors(extended)).toEqual(authors(after));
    }
    // Only provenance differs between sources: the last byte of the retained envelope.
    const fromFull = exported(views.full).bytes,
      fromSnapshot = exported(views.snapshot).bytes;
    expect(fromSnapshot.subarray(0, -1)).toEqual(fromFull.subarray(0, -1));
    expect([fromFull.at(-1), fromSnapshot.at(-1)]).toEqual([0, 1]);
  });

  it('keeps provenance, verified hashes and publications source-specific', () => {
    const o = lived(),
      { full, snapshot, retained } = sources(o),
      older = Ledger.hashRecordBytes(o.records[o.records.length - 2]!);
    expect([full.verification, snapshot.verification, retained.verification]).toEqual([
      'full-history',
      'endorsed-snapshot',
      'full-history',
    ]);
    expect(restored(snapshot).verification).toBe('endorsed-snapshot');
    expect([full.historyStart, snapshot.historyStart, retained.historyStart]).toEqual([
      0,
      full.length - 1,
      full.length - 1,
    ]);
    expect(ok(Ledger.hasVerifiedRecordHash(full, older))).toBe(true);
    expect(ok(Ledger.hasVerifiedRecordHash(retained, older))).toBe(false);
    expect(code(Ledger.epochPublicationRecord(full, 4))).toBe('accepted');
    for (const view of [snapshot, retained])
      expect(code(Ledger.epochPublicationRecord(view, 4))).toBe('unauthorized');
  });

  it('binds which encryption key each retired device had', () => {
    const full = ok(lived().verify()),
      saved = exported(full),
      root = ok(decodeRetainedCbor(saved.bytes)) as CborValue[],
      state = root[4] as CborValue[],
      rows = stateRows(state);
    // Swap the encryption keys of two retired devices: same key sets, other pairing.
    const a = deviceRow(rows, phone),
      b = deviceRow(rows, tablet),
      encA = a.slice(32, 64);
    a.set(b.subarray(32, 64), 32);
    b.set(encA, 32);
    setStateRows(state, rows);
    const { stateDigest, ...position } = saved,
      bytes = ok(encodeRetainedCbor(root));
    const swapped = ok(Ledger.restoreVerifiedState({ ...position, bytes }));
    expect(hex(ok(Snapshots.ledgerStateDigest(swapped)))).not.toBe(hex(stateDigest));
    // With the stored digest, restore itself detects the rewrite.
    expect(code(Ledger.restoreVerifiedState({ ...saved, bytes }))).toBe('state-digest-mismatch');
  });
});

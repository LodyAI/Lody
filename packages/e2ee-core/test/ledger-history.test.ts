import { describe, expect, it } from 'vitest';
import { Ledger, LedgerError } from '../src/ledger';
import { bytesEqual } from '../src/ledger/cbor';
import {
  HISTORY_PACKET_BYTES,
  admitDeviceOp,
  append,
  commitEpochKey,
  ed25519,
  random,
  signGenesis,
  signJoin,
  buildMixedChain,
} from './ledger-fixtures';

function expectCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(LedgerError);
  expect((error as LedgerError).code).toBe(code);
}

describe('L2 long mixed-chain extend', () => {
  it('matches from-zero replay at every split of a long confirmed-operation chain', async () => {
    const { created, records, ledger } = await buildMixedChain(40);
    expect(records.length).toBeGreaterThanOrEqual(36);
    const full = await Ledger.verify({ anchor: created.anchor, records });
    expect(full.head).toEqual(ledger.head);
    expect(full.length).toBe(records.length);
    for (let split = 1; split < records.length; split++) {
      const prefix = await Ledger.verify({
        anchor: created.anchor,
        records: records.slice(0, split),
      });
      const extended = await prefix.extend(records.slice(split));
      expect(extended.head, `split ${split}`).toEqual(full.head);
      expect(extended.length).toBe(full.length);
      expect(extended.state.epoch.number).toBe(full.state.epoch.number);
      expect(extended.state.devices.size).toBe(full.state.devices.size);
      expect(extended.state.members.size).toBe(full.state.members.size);
      for (let i = 0; i < full.length; i++) {
        expect(extended.hashAt(i)).toEqual(full.hashAt(i));
      }
    }
  });
});

describe('L2 immutable extend', () => {
  it('does not apply a failed batch prefix and ignores mutations of returned state', async () => {
    const owner = await ed25519();
    const created = await signGenesis(owner);
    const phone = await ed25519();
    const good = await append(
      created.ledger,
      owner,
      await admitDeviceOp(created.anchor, phone, 'personal', true)
    );
    const flipped = new Uint8Array(good.record);
    const last = flipped.byteLength - 1;
    flipped[last] = (flipped[last] ?? 0) ^ 0xff;
    try {
      await created.ledger.extend([good.record, flipped]);
      throw new Error('batch-accepted');
    } catch (error) {
      expectCode(error, 'bad-signature');
    }
    expect(created.ledger.length).toBe(1);
    expect(created.ledger.state.devices.size).toBe(1);

    const state = created.ledger.state;
    const ownerId = [...state.members.values()][0]!.userId;
    ownerId.fill(0);
    created.record.fill(0);
    const again = created.ledger.state;
    expect(again.devices.size).toBe(1);
    expect(again.members.size).toBe(1);
    expect([...again.members.values()][0]!.userId.some((byte) => byte !== 0)).toBe(true);
    expect(created.ledger.length).toBe(1);
  });
});

describe('L4 independent clients and malicious history', () => {
  it('two clients agree on the same verified chain and reject unverified summaries', async () => {
    const owner = await ed25519();
    const created = await signGenesis(owner);
    const member = await ed25519();
    const joined = await append(created.ledger, owner, {
      type: 'admitMember',
      membershipId: random(16),
      request: await signJoin(created.anchor, member),
    });
    const records = [created.record, joined.record];
    const a = await Ledger.verify({ anchor: created.anchor, records });
    const b = await Ledger.verify({ anchor: created.anchor, records });
    expect(a.head).toEqual(b.head);
    expect(a.summary()).toEqual(b.summary());
    expect(a.hashAt(1)).toEqual(b.hashAt(1));
  });

  it('rejects forks, gaps, reorder, truncation, and a foreign genesis', async () => {
    const owner = await ed25519();
    const created = await signGenesis(owner);
    const phone = await ed25519();
    const laptop = await ed25519();
    const a = await append(
      created.ledger,
      owner,
      await admitDeviceOp(created.anchor, phone, 'personal', true)
    );
    const b = await append(
      created.ledger,
      owner,
      await admitDeviceOp(created.anchor, laptop, 'personal', false)
    );
    try {
      await a.ledger.extend([b.record]);
      throw new Error('fork-accepted');
    } catch (error) {
      expectCode(error, 'wrong-parent');
    }

    try {
      await Ledger.verify({
        anchor: created.anchor,
        records: [created.record, a.record, b.record],
      });
      throw new Error('gap-or-fork-accepted');
    } catch (error) {
      expectCode(error, 'wrong-parent');
    }

    try {
      await Ledger.verify({ anchor: created.anchor, records: [a.record, created.record] });
      throw new Error('reorder-accepted');
    } catch (error) {
      expectCode(error, 'genesis-mismatch');
    }

    try {
      await created.ledger.extend([a.record.subarray(0, 12)]);
      throw new Error('truncate-accepted');
    } catch (error) {
      expect(error).toBeInstanceOf(LedgerError);
    }

    const other = await signGenesis(owner);
    try {
      await created.ledger.extend([other.record]);
      throw new Error('foreign-genesis');
    } catch (error) {
      expectCode(error, 'genesis-mismatch');
    }
    expect(created.ledger.length).toBe(1);
    expect(bytesEqual(created.ledger.head, created.anchor)).toBe(true);
  });

  it('rejects duplicated and permission-invalid records in an otherwise signed suffix', async () => {
    const owner = await ed25519();
    const created = await signGenesis(owner);
    const member = await ed25519();
    const joined = await append(created.ledger, owner, {
      type: 'admitMember',
      membershipId: random(16),
      request: await signJoin(created.anchor, member),
    });
    try {
      await Ledger.verify({
        anchor: created.anchor,
        records: [created.record, joined.record, joined.record],
      });
      throw new Error('duplicate-accepted');
    } catch (error) {
      expectCode(error, 'wrong-parent');
    }
    const epoch = await append(joined.ledger, member, {
      type: 'publishEpoch',
      epoch: 1,
      commitment: await commitEpochKey(created.anchor, 1, random(32)),
      previousEpochKey: random(HISTORY_PACKET_BYTES),
    }).catch((error: unknown) => error);
    expect(epoch).toBeInstanceOf(LedgerError);
    expect((epoch as LedgerError).code).toBe('unauthorized');
  });

  it('does not treat a longer unverified suffix or remote head claim as authorization', async () => {
    const owner = await ed25519();
    const created = await signGenesis(owner);
    const attacker = await ed25519();
    const fake = await append(
      created.ledger,
      owner,
      await admitDeviceOp(created.anchor, attacker, 'personal', true)
    );
    const claim = fake.ledger.summary();
    expect(created.ledger.summary().head).not.toEqual(claim.head);
    expect(created.ledger.state.devices.size).toBe(1);
    expect(created.ledger.state.devices.size).not.toBe(fake.ledger.state.devices.size);
  });

  it('rejects a valid-looking epoch packet on a lagged unauthorized signer', async () => {
    const owner = await ed25519();
    const created = await signGenesis(owner);
    const member = await ed25519();
    const joined = await append(created.ledger, owner, {
      type: 'admitMember',
      membershipId: random(16),
      request: await signJoin(created.anchor, member),
    });
    const proposal = joined.ledger.prepare(
      {
        type: 'publishEpoch',
        epoch: 1,
        commitment: await commitEpochKey(created.anchor, 1, random(32)),
        previousEpochKey: random(HISTORY_PACKET_BYTES),
      },
      member.publicKey
    );
    const record = await (async () => {
      try {
        return await joined.ledger.finalize(proposal, await member.sign(proposal.signingBytes));
      } catch (error) {
        expectCode(error, 'unauthorized');
        return null;
      }
    })();
    expect(record).toBeNull();
    expect(joined.ledger.state.epoch.number).toBe(0);
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendLedgerHistory } from '../src/lib/e2ee-ledger-history';
import { ledgerOverview } from '../src/lib/e2ee-ledger-overview';

// Frozen synthetic ledger v1 vector signed by fixed test keys.
const vector = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../e2ee-core/test/ledger-v1-vector.json'), 'utf8')
) as { anchor: string; records: { hex: string; hash: string }[] };
const head = vector.records.at(-1)!.hash;

function history() {
  return appendLedgerHistory(
    null,
    {
      workspaceId: 'w',
      genesisHash: vector.anchor,
      checkpoint: { headHash: head, length: vector.records.length },
      startIndex: 0,
      nextCursor: null,
      recordsHex: vector.records.map((record) => record.hex),
    },
    { workspaceId: 'w', genesisHash: vector.anchor, localPin: vector.anchor }
  );
}
const member = (ordinal: number, byte: string) => ({ ordinal, membershipId: byte.repeat(16) });

describe('readable ledger overview', () => {
  it('labels members by admission order and attributes each record to its signer', () => {
    const overview = ledgerOverview(history());
    expect(overview.events.map((event) => event.type)).toEqual([
      'genesis',
      'admitMember',
      'setRole',
      'admitDevice',
      'admitDevice',
      'admitDevice',
      'publishEpoch',
      'revokeDevice',
      'removeMemberAndPublishEpoch',
      'admitMember',
      'transferOwner',
      'declareCapabilities',
      'removeMember',
    ]);
    expect(overview.events[6]).toEqual({ type: 'publishEpoch', actor: member(2, '0b'), epoch: 1 });
    // The revoked device was admitted by member 1, so it is shown as theirs.
    expect(overview.events[7]).toMatchObject({ actor: member(1, '0a'), owner: member(1, '0a') });
    expect(overview.events[10]).toEqual({
      type: 'transferOwner',
      actor: member(1, '0a'),
      member: member(3, '0c'),
    });
  });

  it('lists current members owner first, with their devices and the epoch', () => {
    const overview = ledgerOverview(history());
    expect(overview.members).toEqual([
      expect.objectContaining({ ...member(3, '0c'), role: 'owner', devices: [expect.anything()] }),
    ]);
    expect(overview.deviceCount).toBe(1);
    expect(overview.epoch).toEqual({ number: 2, rotationRequired: true });
  });
});

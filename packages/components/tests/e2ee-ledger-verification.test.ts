import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Effect, Result } from 'effect';
import {
  signLedgerSnapshot,
  verifyLedgerSnapshot,
  exportVerifiedState,
  hasVerifiedCheckpoint,
  Bytes,
  extendLedger,
  hashRecordBytes,
} from '@lody/e2ee-core/protocol';
import { envelopeFixture } from '../../e2ee-core/test/keys/fixture';
import { ledgerOverview } from '../src/lib/e2ee-ledger-overview';
import { appendLedgerHistory, hostLedgerHistory, bytesToHex } from '../src/lib/e2ee-ledger-history';
import {
  compareVerificationCode,
  ledgerVerificationCode,
} from '../src/lib/e2ee-ledger-verification';
import type { E2eeWorkspaceHistoryPage } from '@lody/cloud-api';
import { auditLedgerHistory } from '../src/lib/e2ee-ledger-audit';

describe('e2ee-ledger-verification', () => {
  // Frozen synthetic ledger v1 vector signed by fixed test keys.
  const vector = JSON.parse(
    readFileSync(join(import.meta.dirname, '../../e2ee-core/test/ledger-v1-vector.json'), 'utf8')
  ) as { anchor: string; records: { hex: string }[] };
  const head = '2d479a23a222cdb7c843845aa83ee36c9a6a773638db6db7bb0b57ac182628a3';
  const history = appendLedgerHistory(
    null,
    {
      workspaceId: 'w',
      genesisHash: vector.anchor,
      checkpoint: { headHash: head, length: 11 },
      startIndex: 0,
      nextCursor: null,
      recordsHex: vector.records.slice(0, 11).map((record) => record.hex),
    },
    { workspaceId: 'w', genesisHash: vector.anchor, localPin: vector.anchor }
  );
  const sixth = history.records[5]!.hash;
  const code = ledgerVerificationCode(history);

  it('preserves earlier checkpoints across the real host export and restore boundary', () => {
    const exported = Result.getOrThrow(exportVerifiedState(history.view));
    const received = {
      status: {
        workspaceId: 'w',
        genesisHash: vector.anchor,
        length: history.view.length,
        headHash: head,
        stateDigest: bytesToHex(exported.stateDigest.toBytes()),
        position: 'opaque',
        epoch: history.view.inspectState().epoch.number,
        rotationRequired: false,
        deviceKind: 'personal' as const,
        hasCurrentKey: true,
        continuityPending: false,
      },
      stateHex: bytesToHex(exported.bytes),
      recordsHex: history.records.map((record) => record.rawHex),
    };
    const restored = hostLedgerHistory(received);
    expect(
      Result.getOrThrow(
        hasVerifiedCheckpoint(restored.view, {
          length: 6,
          head: Result.getOrThrow(Bytes.recordHash(Buffer.from(sixth, 'hex'))),
        })
      )
    ).toBe(true);
    const damaged = [...received.recordsHex];
    const bytes = Buffer.from(damaged[1]!, 'hex');
    bytes[bytes.length - 1]! ^= 1;
    damaged[1] = bytes.toString('hex');
    expect(() => hostLedgerHistory({ ...received, recordsHex: damaged })).toThrow();
  });

  it('incrementally extends an existing full-history host view while still rejecting mutated prefixes or state digests', () => {
    const prefixHex = vector.records.slice(0, 11).map((record) => record.hex);
    const fullHex = vector.records.map((record) => record.hex);
    const fullHistory = appendLedgerHistory(
      null,
      {
        workspaceId: 'w',
        genesisHash: vector.anchor,
        checkpoint: { headHash: vector.records.at(-1)!.hash, length: vector.records.length },
        startIndex: 0,
        nextCursor: null,
        recordsHex: fullHex,
      },
      { workspaceId: 'w', genesisHash: vector.anchor, localPin: vector.anchor }
    );
    const exportedPrefix = Result.getOrThrow(exportVerifiedState(history.view));
    const prefixView = hostLedgerHistory({
      status: {
        workspaceId: 'w',
        genesisHash: vector.anchor,
        length: history.view.length,
        headHash: head,
        stateDigest: bytesToHex(exportedPrefix.stateDigest.toBytes()),
        position: 'opaque-11',
        epoch: history.view.inspectState().epoch.number,
        rotationRequired: false,
        deviceKind: 'personal',
        hasCurrentKey: true,
        continuityPending: false,
      },
      stateHex: bytesToHex(exportedPrefix.bytes),
      recordsHex: prefixHex,
    });
    const exportedFull = Result.getOrThrow(exportVerifiedState(fullHistory.view));
    const fullInput = {
      status: {
        workspaceId: 'w',
        genesisHash: vector.anchor,
        length: fullHistory.view.length,
        headHash: bytesToHex(fullHistory.view.head.toBytes()),
        stateDigest: bytesToHex(exportedFull.stateDigest.toBytes()),
        position: 'opaque-14',
        epoch: fullHistory.view.inspectState().epoch.number,
        rotationRequired: true,
        deviceKind: 'personal' as const,
        hasCurrentKey: true,
        continuityPending: false,
      },
      stateHex: bytesToHex(exportedFull.bytes),
      recordsHex: fullHex,
    };
    const extended = hostLedgerHistory(fullInput, prefixView);
    expect(extended.view.length).toBe(fullHistory.view.length);
    expect(bytesToHex(extended.view.head.toBytes())).toBe(
      bytesToHex(fullHistory.view.head.toBytes())
    );
    expect(bytesToHex(Result.getOrThrow(exportVerifiedState(extended.view)).stateDigest.toBytes())).toBe(
      bytesToHex(exportedFull.stateDigest.toBytes())
    );
    expect(extended.records.map((record) => record.hash)).toEqual(
      fullHistory.records.map((record) => record.hash)
    );
    expect(hostLedgerHistory(fullInput, extended).view.head.equals(fullHistory.view.head)).toBe(
      true
    );

    const badDigestInput = {
      ...fullInput,
      status: { ...fullInput.status, stateDigest: 'ff'.repeat(32) },
    };
    expect(() => hostLedgerHistory(badDigestInput, prefixView)).toThrow();

    const corruptedPrefix = [...fullHex];
    const bytes = Buffer.from(corruptedPrefix[2]!, 'hex');
    bytes[bytes.length - 1]! ^= 1;
    corruptedPrefix[2] = bytes.toString('hex');
    expect(() =>
      hostLedgerHistory({ ...fullInput, recordsHex: corruptedPrefix }, prefixView)
    ).toThrow();
  });

  describe('ledger verification code', () => {
    it('matches only the same digest at the same version', () => {
      expect(compareVerificationCode(history, { stateDigest: code.stateDigest })).toEqual({
        kind: 'match',
        version: 11,
      });
      expect(
        compareVerificationCode(history, { version: 11, stateDigest: 'ab'.repeat(32) })
      ).toEqual({
        kind: 'mismatch',
      });
      // The right head with a different state is still a mismatch.
      expect(
        compareVerificationCode(history, {
          version: 11,
          headHash: head,
          stateDigest: 'ab'.repeat(32),
        })
      ).toEqual({ kind: 'mismatch' });
      expect(compareVerificationCode(history, { stateDigest: 'ab'.repeat(32) })).toEqual({
        kind: 'unknown',
      });
    });

    it('tells an older or newer ledger apart from a forked one', () => {
      const other = 'ab'.repeat(32);
      expect(
        compareVerificationCode(history, { version: 6, headHash: sixth, stateDigest: other })
      ).toEqual({ kind: 'theirs-older', version: 6, prefixConfirmed: true });
      expect(compareVerificationCode(history, { version: 6, stateDigest: other })).toEqual({
        kind: 'theirs-older',
        version: 6,
        prefixConfirmed: false,
      });
      expect(
        compareVerificationCode(history, { version: 5, headHash: sixth, stateDigest: other })
      ).toEqual({ kind: 'mismatch' });
      expect(compareVerificationCode(history, { version: 12, stateDigest: other })).toEqual({
        kind: 'theirs-newer',
        version: 12,
      });
    });
  });

  it('displays genuine snapshot state with sparse absolute records without inventing a prefix or losing its safety code', async () => {
    const fixture = envelopeFixture();
    fixture.append([9, [1]]);
    const origin = fixture.view();
    const signed = await Effect.runPromise(
      signLedgerSnapshot({ signer: fixture.owner.signer, ledger: () => Effect.succeed(origin) })
    );
    const snapshot = Result.getOrThrow(
      verifyLedgerSnapshot({
        snapshot: signed.snapshot,
        trust: {
          source: 'external-confirmation',
          genesis: origin.genesis,
          head: origin.head,
          length: origin.length,
          endorser: fixture.owner.publicKey,
          membershipId: origin.inspectState().owner,
          role: 'owner',
          kind: 'personal',
          headSignature: signed.headSignature,
        },
      })
    );
    expect(snapshot.verification).toBe('endorsed-snapshot');
    fixture.append([5, fixture.phone.raw]);
    const suffix = fixture.records()[3]!;
    const view = Result.getOrThrow(
      extendLedger(snapshot, [suffix], { head: hashRecordBytes(suffix), length: 4 })
    );
    const retained = Result.getOrThrow(exportVerifiedState(view));
    const state = view.inspectState();
    const received = {
      status: {
        workspaceId: 'synthetic',
        genesisHash: bytesToHex(view.genesis.toBytes()),
        length: view.length,
        headHash: bytesToHex(view.head.toBytes()),
        stateDigest: bytesToHex(retained.stateDigest.toBytes()),
        position: 'opaque-suffix',
        epoch: state.epoch.number,
        rotationRequired: state.epoch.rotationRequired,
        deviceKind: 'personal' as const,
        hasCurrentKey: true,
        continuityPending: false,
      },
      stateHex: bytesToHex(retained.bytes),
      recordsHex: [bytesToHex(fixture.genesisRecord), bytesToHex(suffix)],
      recordPositions: [0, 3],
    };
    const loaded = hostLedgerHistory(received);
    expect(loaded.records.map((record) => record.index)).toEqual([0, 3]);
    const comparison = ledgerVerificationCode(loaded);
    expect(comparison.headHash).toBe(bytesToHex(view.head.toBytes()));
    expect(compareVerificationCode(loaded, comparison)).toEqual({ kind: 'match', version: 4 });
    expect(
      compareVerificationCode(loaded, {
        version: 2,
        headHash: bytesToHex(hashRecordBytes(fixture.records()[1]!).toBytes()),
        stateDigest: '00'.repeat(32),
      })
    ).toEqual({ kind: 'theirs-older', version: 2, prefixConfirmed: false });
    expect(
      compareVerificationCode(loaded, {
        version: 3,
        headHash: bytesToHex(origin.head.toBytes()),
        stateDigest: '00'.repeat(32),
      })
    ).toEqual({ kind: 'theirs-older', version: 3, prefixConfirmed: true });
    expect(
      compareVerificationCode(loaded, {
        version: 1,
        headHash: bytesToHex(view.genesis.toBytes()),
        stateDigest: '00'.repeat(32),
      })
    ).toEqual({ kind: 'theirs-older', version: 1, prefixConfirmed: true });
    expect(ledgerOverview(loaded).events[1]).toMatchObject({
      type: 'revokeDevice',
      actor: { membershipId: '0a'.repeat(16) },
      owner: { membershipId: '0a'.repeat(16) },
    });
    expect(() => hostLedgerHistory({ ...received, recordPositions: [0, 0] })).toThrow(
      'incomplete-local'
    );
    expect(() => hostLedgerHistory({ ...received, recordPositions: undefined })).toThrow(
      'incomplete-local'
    );
  });
});

describe('e2ee-ledger-audit', () => {
  const vector = JSON.parse(
    readFileSync(join(import.meta.dirname, '../../e2ee-core/test/ledger-v1-vector.json'), 'utf8')
  ) as { anchor: string; records: { hex: string }[] };
  const checkpoint = {
    headHash: '2d479a23a222cdb7c843845aa83ee36c9a6a773638db6db7bb0b57ac182628a3',
    length: 11,
  };
  const page: E2eeWorkspaceHistoryPage = {
    workspaceId: 'w',
    genesisHash: vector.anchor,
    checkpoint,
    startIndex: 0,
    recordsHex: vector.records.slice(0, 11).map((record) => record.hex),
    position: 'p11',
    nextCursor: null,
  };
  const trusted = appendLedgerHistory(null, page, {
    workspaceId: 'w',
    genesisHash: vector.anchor,
    localPin: vector.anchor,
  });
  const expected = { ...checkpoint, stateDigest: ledgerVerificationCode(trusted).stateDigest };
  const base = {
    workspaceId: 'w',
    genesisHash: vector.anchor,
    expected,
    signal: new AbortController().signal,
  };

  describe('explicit ledger audit', () => {
    it('replays multiple pages to the same state without mutating the trusted view', async () => {
      const progress: number[] = [];
      const result = await auditLedgerHistory({
        ...base,
        progress: (n) => progress.push(n),
        read: async (request) => {
          expect(request.checkpoint).toEqual(checkpoint);
          return request.cursor
            ? { ...page, startIndex: 4, recordsHex: page.recordsHex.slice(4) }
            : {
                ...page,
                recordsHex: page.recordsHex.slice(0, 4),
                position: 'p4',
                nextCursor: 'c4',
              };
        },
      });
      expect(result).toEqual({ length: 11, stateDigest: expected.stateDigest });
      expect(progress).toEqual([4, 11]);
      expect(ledgerVerificationCode(trusted).stateDigest).toBe(expected.stateDigest);
    });

    it.each(['signature', 'gap', 'endpoint', 'digest'] as const)(
      'rejects %s and preserves original evidence',
      async (fault) => {
        const records = [...page.recordsHex];
        if (fault === 'signature') records[0] = records[0].slice(0, -2) + 'ff';
        await expect(
          auditLedgerHistory({
            ...base,
            expected: fault === 'digest' ? { ...expected, stateDigest: '00'.repeat(32) } : expected,
            progress: () => undefined,
            read: async () => ({
              ...page,
              recordsHex: records,
              ...(fault === 'gap' ? { startIndex: 1 } : {}),
              ...(fault === 'endpoint' ? { checkpoint: { ...checkpoint, length: 12 } } : {}),
            }),
          })
        ).rejects.toThrow();
        expect(ledgerVerificationCode(trusted).stateDigest).toBe(expected.stateDigest);
      }
    );
  });
});

describe('e2ee-ledger-overview', () => {
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
        'declareCapabilities',
      ]);
      expect(overview.events[6]).toEqual({
        type: 'publishEpoch',
        actor: member(2, '0b'),
        epoch: 1,
      });
      // The revoked device was admitted by member 1, so it is shown as theirs.
      expect(overview.events[7]).toMatchObject({ actor: member(1, '0a'), owner: member(1, '0a') });
      expect(overview.events[12]).toEqual({
        type: 'removeMember',
        actor: member(3, '0c'),
        member: member(1, '0a'),
      });
      expect(overview.events[10]).toEqual({
        type: 'transferOwner',
        actor: member(1, '0a'),
        member: member(3, '0c'),
      });
    });

    it('lists current members owner first, with their devices and the epoch', () => {
      const overview = ledgerOverview(history());
      expect(overview.members).toEqual([
        expect.objectContaining({
          ...member(3, '0c'),
          role: 'owner',
          devices: [expect.anything()],
        }),
      ]);
      expect(overview.deviceCount).toBe(1);
      expect(overview.epoch).toEqual({ number: 2, rotationRequired: true });
    });
  });
});

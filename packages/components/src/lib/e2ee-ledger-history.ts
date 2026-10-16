import type { E2eeWorkspaceHistoryPage } from '@lody/cloud-api';
import {
  Bytes,
  decodeRecord,
  extendLedger,
  hashRecordBytes,
  verifyLedger,
  type DecodedRecord,
  type LedgerView,
} from '@lody/e2ee-core/protocol';
import { Result } from 'effect';

export interface ReadableLedgerRecord {
  index: number;
  hash: string;
  rawHex: string;
  body: DecodedRecord['body'];
}

export interface VerifiedLedgerHistory {
  view: LedgerView;
  page: E2eeWorkspaceHistoryPage;
  records: ReadableLedgerRecord[];
  /** Only a separately retained local creation pin confirms the genesis here. */
  locallyPinned: boolean;
  continuityPending: boolean;
}

export interface ObservedLedgerCheckpoint {
  genesisHash: string;
  headHash: string;
  length: number;
}

export const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

function hexToBytes(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})+$/.test(hex)) throw new Error('Invalid ledger encoding');
  return Uint8Array.from(hex.match(/../g)!, (byte) => Number.parseInt(byte, 16));
}

/** Verify each complete prefix. A failed page never changes the previous history. */
export function appendLedgerHistory(
  previous: VerifiedLedgerHistory | null,
  page: E2eeWorkspaceHistoryPage,
  expected: {
    workspaceId: string;
    genesisHash: string;
    localPin: string | null;
    observed?: ObservedLedgerCheckpoint | null;
  }
): VerifiedLedgerHistory {
  const start = previous?.view.length ?? 0;
  if (
    page.workspaceId !== expected.workspaceId ||
    page.genesisHash !== expected.genesisHash ||
    (expected.localPin !== null && page.genesisHash !== expected.localPin) ||
    page.startIndex !== start ||
    page.recordsHex.length === 0 ||
    page.recordsHex.length > 100 ||
    !Number.isSafeInteger(page.checkpoint.length) ||
    page.checkpoint.length < 1 ||
    !/^[0-9a-f]{64}$/.test(page.checkpoint.headHash) ||
    (previous &&
      (previous.page.nextCursor === null ||
        previous.page.checkpoint.length !== page.checkpoint.length ||
        previous.page.checkpoint.headHash !== page.checkpoint.headHash))
  )
    throw new Error('Ledger page does not continue the selected history');
  if (
    expected.observed &&
    (expected.observed.genesisHash !== page.genesisHash ||
      page.checkpoint.length < expected.observed.length)
  )
    throw new Error('Ledger history rolled back');
  const bytes = page.recordsHex.map((hex) => {
    if (hex.length > 16_384) throw new Error('Ledger record too large');
    return hexToBytes(hex);
  });
  const length = start + bytes.length;
  const head = hashRecordBytes(bytes[bytes.length - 1]!);
  if (
    length > page.checkpoint.length ||
    (page.nextCursor === null) !== (length === page.checkpoint.length) ||
    (length === page.checkpoint.length && bytesToHex(head.toBytes()) !== page.checkpoint.headHash)
  ) {
    throw new Error('Ledger endpoint does not match the selected history');
  }
  const anchor = Bytes.genesisHash(hexToBytes(expected.localPin ?? expected.genesisHash));
  if (Result.isFailure(anchor)) throw new Error('Invalid genesis hash');
  const verified = previous
    ? extendLedger(previous.view, bytes, { head, length })
    : verifyLedger({ anchor: anchor.success, records: bytes, checkpoint: { head, length } });
  if (Result.isFailure(verified))
    throw new Error(`Ledger verification failed: ${verified.failure.code}`);
  const records = bytes.map((record, index): ReadableLedgerRecord => {
    const decoded = decodeRecord(record);
    if (Result.isFailure(decoded)) throw new Error('Invalid ledger record');
    return {
      index: start + index,
      hash: bytesToHex(hashRecordBytes(record).toBytes()),
      rawHex: page.recordsHex[index]!,
      body: decoded.success.body,
    };
  });
  const completeRecords = [...(previous?.records ?? []), ...records];
  if (
    expected.observed &&
    length >= expected.observed.length &&
    completeRecords[expected.observed.length - 1]?.hash !== expected.observed.headHash
  )
    throw new Error('Ledger history changed');
  return {
    view: verified.success,
    page,
    records: completeRecords,
    locallyPinned: expected.localPin !== null,
    continuityPending: Boolean(expected.observed && length < expected.observed.length),
  };
}

/** Public protocol fields only; no private key material is held by this reader. */
export function ledgerRecordFields(
  body: DecodedRecord['body']
): Record<string, string | number | null> {
  const signing = { signer: bytesToHex(body.signer.toBytes()) };
  if (body.type === 'genesis')
    return {
      ...signing,
      userId: bytesToHex(body.userId.toBytes()),
      membershipId: bytesToHex(body.membershipId.toBytes()),
      encryptionPublicKey: bytesToHex(body.encryptionPublicKey.toBytes()),
      epochCommitment: bytesToHex(body.epochCommitment.toBytes()),
    };
  const base = { ...signing, previousHash: bytesToHex(body.previousHash.toBytes()) };
  const op = body.operation;
  switch (op.type) {
    case 'admitMember':
      return {
        ...base,
        membershipId: bytesToHex(op.membershipId.toBytes()),
        userId: bytesToHex(op.request.userId.toBytes()),
        signingPublicKey: bytesToHex(op.request.signingPublicKey.toBytes()),
        encryptionPublicKey: bytesToHex(op.request.encryptionPublicKey.toBytes()),
        requestId: bytesToHex(op.request.requestId.toBytes()),
        expiresAt: op.request.expiresAt,
      };
    case 'setRole':
      return { ...base, membershipId: bytesToHex(op.membershipId.toBytes()), role: op.role };
    case 'admitDevice':
      return {
        ...base,
        kind: op.kind,
        signingPublicKey: bytesToHex(op.signingPublicKey.toBytes()),
        encryptionPublicKey: bytesToHex(op.encryptionPublicKey.toBytes()),
      };
    case 'revokeDevice':
      return { ...base, target: bytesToHex(op.target.toBytes()) };
    case 'transferOwner':
      return { ...base, successorMembershipId: bytesToHex(op.successorMembershipId.toBytes()) };
    case 'publishEpoch':
      return { ...base, epoch: op.epoch, commitment: bytesToHex(op.commitment.toBytes()) };
    case 'removeMemberAndPublishEpoch':
      return {
        ...base,
        membershipId: bytesToHex(op.membershipId.toBytes()),
        epoch: op.epoch,
        commitment: bytesToHex(op.commitment.toBytes()),
      };
  }
  throw new Error('Unsupported ledger operation');
}

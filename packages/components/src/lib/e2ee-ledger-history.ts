import type { E2eeWorkspaceHistoryPage } from '@lody/cloud-api';
import {
  Bytes,
  decodeRecord,
  extendLedger,
  hashRecordBytes,
  verifyLedger,
  restoreVerifiedState,
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
  /** Position of a genuine capability declaration this client cannot verify past. */
  upgradeRequiredAt?: number;
}

/** Why a history read stopped. `local-conflict` may indicate a server rollback or
 * fork; it is never repaired by trusting the server's current answer. */
export type E2eeHistoryFailureKind = 'server' | 'local-conflict';

export class E2eeHistoryError extends Error {
  constructor(
    readonly kind: E2eeHistoryFailureKind,
    readonly code: string,
    readonly position?: number
  ) {
    super(`e2ee_history_${code}`);
    this.name = 'E2eeHistoryError';
  }
}

export interface ObservedLedgerCheckpoint {
  genesisHash: string;
  headHash: string;
  length: number;
}

export const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

function hexToBytes(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})+$/.test(hex)) throw new E2eeHistoryError('server', 'encoding');
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
  if (expected.localPin !== null && page.genesisHash !== expected.localPin)
    throw new E2eeHistoryError('local-conflict', 'pin-mismatch');
  if (
    page.workspaceId !== expected.workspaceId ||
    page.genesisHash !== expected.genesisHash ||
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
    throw new E2eeHistoryError('server', 'discontinuous-page');
  if (
    expected.observed &&
    (expected.observed.genesisHash !== page.genesisHash ||
      page.checkpoint.length < expected.observed.length)
  )
    throw new E2eeHistoryError('local-conflict', 'rolled-back');
  const bytes = page.recordsHex.map((hex) => {
    if (hex.length > 16_384) throw new E2eeHistoryError('server', 'oversize');
    return hexToBytes(hex);
  });
  const length = start + bytes.length;
  const head = hashRecordBytes(bytes[bytes.length - 1]!);
  if (
    length > page.checkpoint.length ||
    (page.nextCursor === null) !== (length === page.checkpoint.length) ||
    (length === page.checkpoint.length && bytesToHex(head.toBytes()) !== page.checkpoint.headHash)
  ) {
    throw new E2eeHistoryError('server', 'endpoint-mismatch');
  }
  const anchor = Bytes.genesisHash(hexToBytes(expected.localPin ?? expected.genesisHash));
  if (Result.isFailure(anchor)) throw new E2eeHistoryError('server', 'genesis');
  const verify = (records: Uint8Array[], total: number) =>
    previous
      ? extendLedger(previous.view, records, {
          head: hashRecordBytes(records[records.length - 1]!),
          length: total,
        })
      : verifyLedger({
          anchor: anchor.success,
          records,
          checkpoint: { head: hashRecordBytes(records[records.length - 1]!), length: total },
        });
  let verified = verify(bytes, length);
  let accepted = bytes;
  let upgradeRequiredAt: number | undefined;
  if (Result.isFailure(verified)) {
    const { code, position } = verified.failure;
    // A genuine future record: keep the verified prefix and stop, never skip it.
    if (code !== 'upgrade-required' || position === undefined || position < start)
      throw new E2eeHistoryError('server', code, position);
    upgradeRequiredAt = position;
    accepted = bytes.slice(0, position - start);
    if (accepted.length === 0) {
      if (!previous) throw new E2eeHistoryError('server', code, position);
      return {
        ...previous,
        page,
        upgradeRequiredAt,
        continuityPending: Boolean(expected.observed && position < expected.observed.length),
      };
    }
    verified = verify(accepted, position);
    if (Result.isFailure(verified))
      throw new E2eeHistoryError('server', verified.failure.code, verified.failure.position);
  }
  const verifiedLength = start + accepted.length;
  const records = accepted.map((record, index): ReadableLedgerRecord => {
    const decoded = decodeRecord(record);
    if (Result.isFailure(decoded)) throw new E2eeHistoryError('server', 'record', start + index);
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
    verifiedLength >= expected.observed.length &&
    completeRecords[expected.observed.length - 1]?.hash !== expected.observed.headHash
  )
    throw new E2eeHistoryError('local-conflict', 'history-changed');
  return {
    view: verified.success,
    page,
    records: completeRecords,
    locallyPinned: expected.localPin !== null,
    continuityPending: Boolean(expected.observed && verifiedLength < expected.observed.length),
    ...(upgradeRequiredAt === undefined ? {} : { upgradeRequiredAt }),
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
    case 'removeMember':
      return { ...base, membershipId: bytesToHex(op.membershipId.toBytes()) };
    case 'removeMemberAndPublishEpoch':
      return {
        ...base,
        membershipId: bytesToHex(op.membershipId.toBytes()),
        epoch: op.epoch,
        commitment: bytesToHex(op.commitment.toBytes()),
      };
    case 'declareCapabilities':
      return { ...base, capabilities: op.capabilities.join(', ') };
  }
  throw new Error('Unsupported ledger operation');
}

/** Decode the main process's own verified public view for display. Authority stays in the host. */
export function hostLedgerHistory(
  input: import('@lody/platform').E2eeRuntimeLedgerView
): VerifiedLedgerHistory {
  const status = input.status;
  const view = Result.getOrThrow(
    restoreVerifiedState({
      bytes: hexToBytes(input.stateHex),
      genesis: Result.getOrThrow(Bytes.genesisHash(hexToBytes(status.genesisHash))),
      head: Result.getOrThrow(Bytes.recordHash(hexToBytes(status.headHash))),
      length: status.length,
      stateDigest: Result.getOrThrow(Bytes.recordHash(hexToBytes(status.stateDigest))),
    })
  );
  const positions = input.recordPositions ?? input.recordsHex.map((_, index) => index);
  if (
    positions.length !== input.recordsHex.length ||
    (input.recordPositions === undefined && input.recordsHex.length !== view.length) ||
    positions.some(
      (position, index) =>
        !Number.isSafeInteger(position) ||
        position < 0 ||
        position >= view.length ||
        (index > 0 && position <= positions[index - 1]!)
    )
  )
    throw new E2eeHistoryError('local-conflict', 'incomplete-local');
  const records = input.recordsHex.map((rawHex, index) => {
    const bytes = hexToBytes(rawHex);
    const position = positions[index]!;
    const hash = bytesToHex(hashRecordBytes(bytes).toBytes());
    if (
      (position === 0 && hash !== status.genesisHash) ||
      (position === view.length - 1 && hash !== status.headHash)
    )
      throw new E2eeHistoryError('local-conflict', 'history-changed');
    return { index: position, rawHex, hash, body: Result.getOrThrow(decodeRecord(bytes)).body };
  });
  return {
    view,
    records,
    locallyPinned: true,
    continuityPending: status.continuityPending,
    ...(status.upgradeRequiredAt === undefined
      ? {}
      : { upgradeRequiredAt: status.upgradeRequiredAt }),
    page: {
      workspaceId: status.workspaceId,
      genesisHash: status.genesisHash,
      startIndex: 0,
      recordsHex: [...input.recordsHex],
      checkpoint: { length: status.length, headHash: status.headHash },
      position: status.position ?? '-1',
      nextCursor: null,
    },
  };
}

import { historicalContentIdentity, type DeviceKind, type Role } from '@lody/e2ee-core/protocol';
import { Result } from 'effect';
import { bytesToHex, type VerifiedLedgerHistory } from './e2ee-ledger-history';

/** Members are labelled by admission order on this page: member 1 created the workspace. */
export interface LedgerMemberLabel {
  /** 1-based admission order among loaded records; null when admitted in unloaded history. */
  ordinal: number | null;
  membershipId: string;
}

export interface LedgerMemberOverview extends LedgerMemberLabel {
  userId: string;
  role: Role;
  devices: { key: string; kind: DeviceKind }[];
}

/** One history row: who did what to whom, all from verified record fields. */
export type LedgerEventSummary =
  | { type: 'genesis'; actor: LedgerMemberLabel }
  | { type: 'admitMember'; actor: LedgerMemberLabel | null; member: LedgerMemberLabel }
  | { type: 'setRole'; actor: LedgerMemberLabel | null; member: LedgerMemberLabel; role: Role }
  | { type: 'admitDevice'; actor: LedgerMemberLabel | null; device: string; kind: DeviceKind }
  | {
      type: 'revokeDevice';
      actor: LedgerMemberLabel | null;
      device: string;
      /** The member the device belonged to, when its admission was loaded. */
      owner: LedgerMemberLabel | null;
    }
  | { type: 'transferOwner'; actor: LedgerMemberLabel | null; member: LedgerMemberLabel }
  | { type: 'publishEpoch'; actor: LedgerMemberLabel | null; epoch: number }
  | {
      type: 'removeMemberAndPublishEpoch';
      actor: LedgerMemberLabel | null;
      member: LedgerMemberLabel;
      epoch: number;
    }
  | { type: 'declareCapabilities'; actor: LedgerMemberLabel | null; capabilities: string };

export interface LedgerOverview {
  members: LedgerMemberOverview[];
  deviceCount: number;
  epoch: { number: number; rotationRequired: boolean };
  /** Same order as `history.records`. */
  events: LedgerEventSummary[];
}

type ReadableSigner = import('@lody/e2ee-core/protocol').Bytes.SigningPublicKey;

const ROLE_ORDER: Record<Role, number> = { owner: 0, admin: 1, member: 2, guest: 3 };

/**
 * A readable projection of verified history. It adds no authority: labels and
 * attributions come only from records the ledger verifier already accepted.
 */
export function ledgerOverview(history: VerifiedLedgerHistory): LedgerOverview {
  const ordinals = new Map<string, number>();
  const deviceMember = new Map<string, string>();
  const label = (membershipId: string): LedgerMemberLabel => ({
    ordinal: ordinals.get(membershipId) ?? null,
    membershipId,
  });
  let contiguousPrefix = true;
  const admit = (membershipId: string) => {
    if (contiguousPrefix && !ordinals.has(membershipId))
      ordinals.set(membershipId, ordinals.size + 1);
  };
  const actorOf = (signer: ReadableSigner) => {
    const membership = deviceMember.get(bytesToHex(signer.toBytes()));
    if (membership !== undefined) return label(membership);
    const identity = historicalContentIdentity(history.view, signer);
    return Result.isFailure(identity)
      ? null
      : label(bytesToHex(identity.success.memberInstance.toBytes()));
  };
  const events = history.records.map((record, index): LedgerEventSummary => {
    if (record.index !== index) contiguousPrefix = false;
    const body = record.body;
    const signer = bytesToHex(body.signer.toBytes());
    if (body.type === 'genesis') {
      const membership = bytesToHex(body.membershipId.toBytes());
      admit(membership);
      deviceMember.set(signer, membership);
      return { type: 'genesis', actor: label(membership) };
    }
    const actor = actorOf(body.signer);
    const op = body.operation;
    switch (op.type) {
      case 'admitMember': {
        const membership = bytesToHex(op.membershipId.toBytes());
        admit(membership);
        deviceMember.set(bytesToHex(op.request.signingPublicKey.toBytes()), membership);
        return { type: 'admitMember', actor, member: label(membership) };
      }
      case 'setRole':
        return {
          type: 'setRole',
          actor,
          member: label(bytesToHex(op.membershipId.toBytes())),
          role: op.role,
        };
      case 'admitDevice': {
        const device = bytesToHex(op.signingPublicKey.toBytes());
        // A device is admitted by a device of its own member.
        if (actor) deviceMember.set(device, actor.membershipId);
        return { type: 'admitDevice', actor, device, kind: op.kind };
      }
      case 'revokeDevice': {
        const device = bytesToHex(op.target.toBytes());
        const identity = historicalContentIdentity(history.view, op.target);
        const owner =
          deviceMember.get(device) ??
          (Result.isSuccess(identity)
            ? bytesToHex(identity.success.memberInstance.toBytes())
            : undefined);
        return {
          type: 'revokeDevice',
          actor,
          device,
          owner: owner === undefined ? null : label(owner),
        };
      }
      case 'transferOwner':
        return {
          type: 'transferOwner',
          actor,
          member: label(bytesToHex(op.successorMembershipId.toBytes())),
        };
      case 'publishEpoch':
        return { type: 'publishEpoch', actor, epoch: op.epoch };
      case 'removeMemberAndPublishEpoch':
        return {
          type: 'removeMemberAndPublishEpoch',
          actor,
          member: label(bytesToHex(op.membershipId.toBytes())),
          epoch: op.epoch,
        };
      case 'declareCapabilities':
        return { type: 'declareCapabilities', actor, capabilities: op.capabilities.join(', ') };
    }
    throw new Error('Unsupported ledger operation');
  });

  const state = history.view.inspectState();
  const devicesByMember = new Map<string, { key: string; kind: DeviceKind }[]>();
  for (const [key, device] of state.devices) {
    const membership = bytesToHex(device.membershipId.toBytes());
    devicesByMember.set(membership, [
      ...(devicesByMember.get(membership) ?? []),
      { key, kind: device.kind },
    ]);
  }
  const members = [...state.members]
    .map(([membershipId, member]) => ({
      ...label(membershipId),
      userId: bytesToHex(member.userId.toBytes()),
      role: member.role,
      devices: devicesByMember.get(membershipId) ?? [],
    }))
    .sort(
      (a, b) =>
        ROLE_ORDER[a.role] - ROLE_ORDER[b.role] ||
        (a.ordinal ?? Number.MAX_SAFE_INTEGER) - (b.ordinal ?? Number.MAX_SAFE_INTEGER) ||
        a.membershipId.localeCompare(b.membershipId)
    );
  return {
    members,
    deviceCount: state.devices.size,
    epoch: { number: state.epoch.number, rotationRequired: state.epoch.rotationRequired },
    events,
  };
}

/** First 8 hex digits: enough to tell keys and IDs apart at a glance. */
export const shortId = (hex: string) => hex.slice(0, 8);

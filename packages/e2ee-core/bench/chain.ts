import { decodeRecord } from '../src/ledger/schema';
import {
  HISTORY_PACKET_BYTES,
  admitDeviceOp,
  append,
  commitEpochKey,
  ed25519,
  findMembership,
  random,
  signGenesis,
  signJoin,
  type DeviceKeys,
} from '../test/ledger-fixtures';

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank))]!;
}

export function countSignatures(records: readonly Uint8Array[]): number {
  let signatures = 0;
  for (const record of records) {
    signatures += 1;
    const decoded = decodeRecord(record);
    if (decoded.body.type !== 'ordinary') continue;
    const operation = decoded.body.fields.operation;
    if (operation.type === 'admitMember' || operation.type === 'admitDevice') signatures += 1;
  }
  return signatures;
}

export async function buildChain(count: number) {
  const owner = await ed25519();
  const created = await signGenesis(owner);
  const records = [created.record];
  let ledger = created.ledger;
  const members: { userId: Uint8Array }[] = [];
  const extraOwnerDevices: DeviceKeys[] = [];
  while (records.length < count) {
    const step = records.length % 8;
    let next: Awaited<ReturnType<typeof append>>;
    if (step === 1) {
      const applicant = await ed25519();
      const request = await signJoin(created.anchor, applicant);
      members.push({ userId: request.userId });
      next = await append(ledger, owner, {
        type: 'admitMember',
        membershipId: random(16),
        request,
      });
    } else if (step === 2 && members.length > 1) {
      const target = members.shift()!;
      next = await append(ledger, owner, {
        type: 'removeMember',
        membershipId: findMembership(ledger, target.userId),
      });
    } else if (step === 3) {
      next = await append(ledger, owner, {
        type: 'publishEpoch',
        epoch: ledger.state.epoch.number + 1,
        commitment: await commitEpochKey(created.anchor, ledger.state.epoch.number + 1, random(32)),
        previousEpochKey: random(HISTORY_PACKET_BYTES),
      });
    } else if (step === 4 && extraOwnerDevices.length > 0) {
      const target = extraOwnerDevices.pop()!;
      next = await append(ledger, owner, { type: 'revokeDevice', target: target.publicKey });
    } else {
      const device = await ed25519();
      const kind = step === 5 ? 'machine' : step === 6 ? 'recovery' : 'personal';
      if (kind === 'personal') extraOwnerDevices.push(device);
      next = await append(
        ledger,
        owner,
        await admitDeviceOp(created.anchor, created.membershipId, device, kind, false)
      );
    }
    records.push(next.record);
    ledger = next.ledger;
    if (records.length % 1000 === 0) {
      process.stderr.write(`generated ${records.length}/${count}\n`);
    }
  }
  return { owner, created, records, ledger };
}

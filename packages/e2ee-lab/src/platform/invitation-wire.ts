import { Result, Schema } from 'effect';
import { Bytes } from '@lody/e2ee-core';
import type { WorkspaceInvitationSnapshot } from '@lody/e2ee-core';
const hex = Schema.String.check(Schema.isPattern(/^[0-9a-f]+$/));
export const InvitationSnapshotWire = Schema.Struct({
  workspaceId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  snapshot: hex.check(Schema.isMaxLength(4 * 1024 * 1024)),
  head: hex.check(Schema.isMinLength(64), Schema.isMaxLength(64)),
  length: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  headSignature: hex.check(Schema.isMinLength(128), Schema.isMaxLength(128)),
  offset: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
});
export function invitationSnapshotWire(receipt: WorkspaceInvitationSnapshot) {
  return {
    workspaceId: receipt.workspaceId,
    snapshot: Buffer.from(receipt.snapshot).toString('hex'),
    head: Buffer.from(receipt.head.toBytes()).toString('hex'),
    length: receipt.length,
    headSignature: Buffer.from(receipt.headSignature.toBytes()).toString('hex'),
    offset: receipt.offset,
  };
}
export function parseInvitationSnapshot(value: unknown) {
  return Result.gen(function* () {
    const wire = yield* Schema.decodeUnknownResult(InvitationSnapshotWire)(value);
    return {
      workspaceId: wire.workspaceId,
      snapshot: new Uint8Array(Buffer.from(wire.snapshot, 'hex')),
      head: yield* Bytes.recordHash(new Uint8Array(Buffer.from(wire.head, 'hex'))),
      length: wire.length,
      headSignature: yield* Bytes.signature(new Uint8Array(Buffer.from(wire.headSignature, 'hex'))),
      offset: wire.offset,
    } satisfies WorkspaceInvitationSnapshot;
  });
}

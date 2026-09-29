import type { MachineId } from '@lody/shared';
import { prepareDraftAttachments } from '../lib/session-attachment-preparation';
import { createPendingSessionSends } from '../lib/session-pending-sends';
import {
  deliverUserTurn,
  writeUserTurn,
  type SessionSendRuntime,
} from '../lib/session-send-delivery';

/**
 * The workspace's in-memory queue for sends whose attachments are still being
 * prepared. Preparation borrows the workspace send resources, so disposing
 * them cancels uploads; nothing here survives the page.
 */
export function createWorkspacePendingSends(args: {
  runtime: SessionSendRuntime;
  token(): string | null;
  localMachineId(): MachineId | null;
}) {
  const { runtime } = args;
  return createPendingSessionSends({
    prepare: (send, signal, update) => {
      let attachments = send.attachments;
      const publish = (next: typeof attachments) => {
        attachments = next;
        update(next);
      };
      return prepareDraftAttachments({
        record: send,
        signal,
        resources: runtime.sendResources,
        token: args.token,
        localMachineId: args.localMachineId,
        update: publish,
        report: (id, progress) =>
          publish(
            attachments.map((attachment) =>
              attachment.id === id ? { ...attachment, progress } : attachment
            )
          ),
      });
    },
    write: (send, signal) => runtime.sendResources.run((owned) => writeUserTurn(runtime, send, owned), signal),
    deliver: (send) => deliverUserTurn(runtime, send),
  });
}

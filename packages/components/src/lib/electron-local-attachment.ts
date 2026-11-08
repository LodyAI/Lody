import type { SessionInputBlock } from '@lody/shared';
import { getIpcServices } from './electron-ipc-client';
import { throwIfSendAborted } from './session-send-resources';
import type { SessionAttachmentDraft } from './session-attachment-draft';

type PrepareLocalAttachmentArgs = {
  workspaceId: string;
  sessionId: string;
  machineId: string;
  turnId: string;
  attachment: SessionAttachmentDraft;
  signal: AbortSignal;
};

/** Native images and files share source ownership and cancellation; the host owns registration. */
export async function prepareElectronLocalAttachment(
  args: PrepareLocalAttachmentArgs
): Promise<SessionInputBlock> {
  throwIfSendAborted(args.signal);
  const ipc = getIpcServices();
  if (!ipc) throw new Error('Local attachment capability is unavailable');
  const { attachment } = args;
  const source = attachment.localSourcePath
    ? { path: attachment.localSourcePath }
    : { bytes: await attachment.source!.arrayBuffer() };
  throwIfSendAborted(args.signal);
  const payload = {
    workspaceId: args.workspaceId,
    sessionId: args.sessionId,
    machineId: args.machineId,
    fileName: attachment.name,
    mimeType: attachment.mimeType || 'application/octet-stream',
    source,
  };
  if (attachment.kind === 'image') {
    const result = await ipc.localProjects.prepareLocalImage({
      ...payload,
      imageId: attachment.localReferenceId!,
    });
    throwIfSendAborted(args.signal);
    if (!result.ok) throw new Error(result.error);
    return { type: 'image', ...result.image };
  }
  const result = await ipc.localProjects.prepareLocalAttachment({
    ...payload,
    turnId: args.turnId,
    referenceId: attachment.localReferenceId!,
    kind: attachment.kind,
  });
  throwIfSendAborted(args.signal);
  if (!result.ok) throw new Error(result.error);
  return result.attachment;
}

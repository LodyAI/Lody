import type { SessionLocalAttachment, SessionInputBlock } from '@lody/shared';
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

export async function prepareElectronLocalImage(
  args: PrepareLocalAttachmentArgs
): Promise<Extract<SessionInputBlock, { type: 'image' }>> {
  throwIfSendAborted(args.signal);
  const ipc = getIpcServices();
  if (!ipc) throw new Error('Local image capability is unavailable');
  const { attachment } = args;
  const source = attachment.localSourcePath
    ? { path: attachment.localSourcePath }
    : { bytes: await attachment.source!.arrayBuffer() };
  throwIfSendAborted(args.signal);
  const result = await ipc.localProjects.prepareLocalImage({
    workspaceId: args.workspaceId,
    sessionId: args.sessionId,
    machineId: args.machineId,
    imageId: attachment.localReferenceId!,
    fileName: attachment.name,
    mimeType: attachment.mimeType,
    source,
  });
  throwIfSendAborted(args.signal);
  if (!result.ok) throw new Error(result.error);
  return { type: 'image', ...result.image };
}

export async function prepareElectronLocalAttachment(args: PrepareLocalAttachmentArgs): Promise<SessionLocalAttachment> {
  throwIfSendAborted(args.signal);
  const ipc = getIpcServices();
  if (!ipc) throw new Error('Local attachment capability is unavailable');
  const { attachment } = args;
  const source = attachment.localSourcePath
    ? { path: attachment.localSourcePath }
    : { bytes: await attachment.source!.arrayBuffer() };
  throwIfSendAborted(args.signal);
  const result = await ipc.localProjects.prepareLocalAttachment({
    workspaceId: args.workspaceId,
    sessionId: args.sessionId,
    machineId: args.machineId,
    turnId: args.turnId,
    referenceId: attachment.localReferenceId!,
    kind: attachment.kind,
    fileName: attachment.name,
    mimeType: attachment.mimeType || 'application/octet-stream',
    source,
  });
  throwIfSendAborted(args.signal);
  if (!result.ok) throw new Error(result.error);
  return result.attachment;
}

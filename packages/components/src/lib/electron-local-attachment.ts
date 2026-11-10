import type { SessionInputBlock } from '@lody/shared';
import { getIpcServices } from './electron-ipc-client';
import { throwIfSendAborted } from './session-send-resources';
import type { SessionAttachmentDraft } from './session-attachment-draft';

type PrepareLocalAttachmentArgs = {
  workspaceId: string;
  sessionId: string;
  machineId: string;
  attachment: SessionAttachmentDraft;
  signal: AbortSignal;
};

/** Native images and files share source ownership and cancellation; the host prepares durable paths. */
export async function prepareElectronLocalAttachment(
  args: PrepareLocalAttachmentArgs
): Promise<SessionInputBlock> {
  throwIfSendAborted(args.signal);
  const { attachment } = args;
  if (attachment.kind === 'file' && attachment.localSourcePath) {
    return {
      type: 'local_attachment',
      machineId: args.machineId,
      path: attachment.localSourcePath,
      kind: 'file',
      fileName: attachment.name,
      mimeType: attachment.mimeType || 'application/octet-stream',
      sizeBytes: attachment.source!.size,
    };
  }
  const ipc = getIpcServices();
  if (!ipc) throw new Error('Local attachment capability is unavailable');
  const payload = {
    workspaceId: args.workspaceId,
    sessionId: args.sessionId,
    machineId: args.machineId,
    fileName: attachment.name,
    mimeType: attachment.mimeType || 'application/octet-stream',
  };
  if (attachment.kind === 'image') {
    const source = attachment.localSourcePath
      ? { path: attachment.localSourcePath }
      : { bytes: await attachment.source!.arrayBuffer() };
    throwIfSendAborted(args.signal);
    const result = await ipc.localProjects.prepareLocalImage({
      ...payload,
      source,
      imageId: attachment.localImageId!,
    });
    throwIfSendAborted(args.signal);
    if (!result.ok) throw new Error(result.error);
    return { type: 'image', ...result.image };
  }
  const bytes = await attachment.source!.arrayBuffer();
  throwIfSendAborted(args.signal);
  const result = await ipc.localProjects.prepareLocalAttachment({
    ...payload,
    source: { bytes },
    kind: attachment.kind,
  });
  throwIfSendAborted(args.signal);
  if (!result.ok) throw new Error(result.error);
  return result.attachment;
}

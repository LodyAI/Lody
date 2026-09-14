import {
  inputBlocksToHistoryItems,
  type MachineId,
  type SessionId,
  type WorkspaceId,
  type SessionInputBlock,
} from '@lody/shared';
import { prepareSessionFile } from './session-file-preparation';
import { uploadSessionImage } from './session-image-upload';
import { canUseElectronLocalFileSend } from './electron-session-file-sender';
import { throwIfSendAborted, type SessionSendResources } from './session-send-resources';
import { preparedDraftInput } from './session-attachment-draft';
import type { SessionSendRecord } from './session-send-journal';

export async function prepareDraftAttachments(args: {
  record: SessionSendRecord;
  resources: SessionSendResources;
  signal: AbortSignal;
  token(): string | null;
  localMachineId(): MachineId | null;
  checkpoint(
    patch: Partial<Pick<SessionSendRecord, 'attachments' | 'entry' | 'queue'>>
  ): Promise<void>;
  report(id: string, progress: number): void;
}) {
  let attachments = args.record.attachments ?? [];
  if (!attachments.length) return;
  let failure: unknown;
  // One transfer at a time per message bounds hashing memory and preserves
  // successful results; different conversations retain independent lifetimes.
  for (const attachment of attachments) {
    if (attachment.ready) continue;
    throwIfSendAborted(args.signal);
    try {
      const file = new File([attachment.source], attachment.name, {
        type: attachment.mimeType,
        lastModified: attachment.lastModified,
      });
      let ready: SessionInputBlock;
      if (attachment.kind === 'image') {
        const token = args.token();
        if (!token) throw new Error('Image upload requires authentication');
        const image = await args.resources.run(
          (signal) =>
            uploadSessionImage({
              workspaceId: args.record.workspaceId as WorkspaceId,
              sessionId: args.record.sessionId,
              token,
              file,
              signal,
              onProgress: (progress) => args.report(attachment.id, progress),
            }),
          args.signal
        );
        ready = { type: 'image', ...image };
      } else {
        const machineId = args.record.targetMachineId ?? null;
        const fileResult = await prepareSessionFile(args.resources, {
          workspaceId: args.record.workspaceId as WorkspaceId,
          sessionId: args.record.sessionId as SessionId,
          token: args.token(),
          machineId,
          canSendLocally:
            !!machineId && machineId === args.localMachineId() && canUseElectronLocalFileSend(),
          file,
          signal: args.signal,
          onProgress: (progress) => args.report(attachment.id, progress.percent),
        });
        ready = fileResult;
      }
      throwIfSendAborted(args.signal);
      attachments = attachments.map((item) =>
        item.id === attachment.id ? { ...item, ready, error: undefined, progress: 100 } : item
      );
      await args.checkpoint({ attachments });
    } catch (error) {
      throwIfSendAborted(args.signal);
      failure = error;
      attachments = attachments.map((item) =>
        item.id === attachment.id
          ? {
              ...item,
              error: error instanceof Error ? error.message : 'Attachment preparation failed',
              progress: 0,
            }
          : item
      );
      await args.checkpoint({ attachments });
    }
  }
  if (failure) throw failure;
  const inputBlocks = preparedDraftInput(args.record.entry.inputConfig, attachments);
  const inputConfig = { ...args.record.entry.inputConfig, inputBlocks };
  await args.checkpoint({
    attachments,
    entry: { ...args.record.entry, items: inputBlocksToHistoryItems(inputBlocks), inputConfig },
    ...(args.record.queue
      ? {
          queue: {
            ...args.record.queue,
            acpSessionConfig: { ...(args.record.queue.acpSessionConfig as object), inputBlocks },
          },
        }
      : {}),
  });
}

import { resolveAttachmentRoute } from './session-attachment-routing';
import { prepareElectronLocalAttachment, prepareElectronLocalImage } from './electron-local-attachment';
import { isElectronRenderer } from './electron';
import { assertProtectedAttachmentReferences } from './encrypted-session-attachment';
import { authorizePlaintextAttachmentPreparation } from './attachment-workspace-access';
import type { WorkspaceStreamsMode } from '@lody/shared/workspace-streams-content';
import {
  inputBlocksToHistoryItems,
  type MachineId,
  type SessionId,
  type WorkspaceId,
  type SessionInputBlock,
} from '@lody/shared';
import { prepareSessionFile } from './session-file-preparation';
import { uploadSessionImage, validateSessionImageFile } from './session-image-upload';
import { throwIfSendAborted, type SessionSendResources } from './session-send-resources';
import { preparedDraftInput } from './session-attachment-draft';
import type { PendingSessionSend } from './session-pending-sends';
import { seedSessionImageCache } from './session-image-cache';
import { isNativeIOSAppShell } from './native-platform';

type DraftAttachmentSend = Pick<
  PendingSessionSend,
  'workspaceId' | 'sessionId' | 'entry' | 'queue' | 'attachments' | 'targetMachineId'
>;
type PreparedSend = Pick<PendingSessionSend, 'entry' | 'queue' | 'attachments'>;

/** Replace draft attachments with their ready references in the turn and queue row. */
export function finalizePreparedSend(record: DraftAttachmentSend): PreparedSend {
  const inputBlocks = preparedDraftInput(record.entry.inputConfig, record.attachments);
  const inputConfig = { ...record.entry.inputConfig, inputBlocks };
  return {
    attachments: record.attachments.map((item) => ({ ...item, source: undefined })),
    entry: { ...record.entry, items: inputBlocksToHistoryItems(inputBlocks), inputConfig },
    ...(record.queue
      ? {
          queue: {
            ...record.queue,
            acpSessionConfig: { ...(record.queue.acpSessionConfig as object), inputBlocks },
          },
        }
      : {}),
  };
}

/**
 * Prepare every unready attachment, one at a time, publishing each result
 * through `update`. Rejects with the first failure after trying the rest, so a
 * retry only transfers what failed.
 */
export async function prepareDraftAttachments(args: {
  content: WorkspaceStreamsMode;
  record: DraftAttachmentSend;
  resources: SessionSendResources;
  signal: AbortSignal;
  token(): string | null;
  attachmentToken?: () => Promise<string>;
  localMachineId(): MachineId | null;
  validateLocalTarget(kind: 'image' | 'file'): Promise<void>;
  update(attachments: DraftAttachmentSend['attachments']): void;
  report(id: string, progress: number): void;
}): Promise<PreparedSend> {
  let attachments = args.record.attachments;
  let failure: unknown;
  // One transfer at a time per message bounds hashing memory and preserves
  // successful results; different conversations retain independent lifetimes.
  for (const attachment of attachments) {
    if (attachment.ready) continue;
    throwIfSendAborted(args.signal);
    try {
      if (!attachment.source) throw new Error('Attachment source is unavailable');
      const file = new File([attachment.source], attachment.name, {
        type: attachment.mimeType,
        lastModified: attachment.lastModified,
      });
      let ready: SessionInputBlock;
      const machineId = args.record.targetMachineId ?? null;
      const route = resolveAttachmentRoute({
        native: isElectronRenderer(),
        localMachineId: args.localMachineId(),
        targetMachineId: machineId,
      });
      if (route === 'transfer' && args.content.mode !== 'protected')
        await authorizePlaintextAttachmentPreparation(args.record.workspaceId, args.signal, args.record.entry.userId);
      if (route === 'local') {
        await args.validateLocalTarget(attachment.kind);
        if (args.content.mode === 'protected')
          throw new Error('Protected local attachment preparation is unavailable');
        if (!attachment.localReferenceId) {
          attachment.localReferenceId = crypto.randomUUID();
          args.update(attachments);
        }
        if (attachment.kind === 'image') {
          const validationError = validateSessionImageFile(file);
          if (validationError) throw new Error(validationError);
        }
        const prepare = attachment.kind === 'image'
          ? prepareElectronLocalImage
          : prepareElectronLocalAttachment;
        ready = await args.resources.run<SessionInputBlock>(
          (signal) =>
            prepare({
              workspaceId: args.record.workspaceId,
              sessionId: args.record.sessionId,
              machineId: machineId!,
              turnId: args.record.entry.id!,
              attachment,
              signal,
            }),
          args.signal
        );
      } else if (attachment.kind === 'image') {
        const token = args.token();
        if (!token) throw new Error('Image transfer requires authentication');
        const image = await args.resources.run(
          (signal) =>
            uploadSessionImage({
              content: args.content,
              accountId: args.record.entry.userId,
              workspaceId: args.record.workspaceId as WorkspaceId,
              sessionId: args.record.sessionId,
              token,
              attachmentToken: args.attachmentToken,
              file,
              signal,
              onProgress: (progress) => args.report(attachment.id, progress),
            }),
          args.signal
        );
        ready = { type: 'image', ...image };
      } else {
        const fileResult = await prepareSessionFile(args.resources, {
          content: args.content,
          accountId: args.record.entry.userId,
          workspaceId: args.record.workspaceId as WorkspaceId,
          sessionId: args.record.sessionId as SessionId,
          token: args.token(),
          attachmentToken: args.attachmentToken,
          file,
          signal: args.signal,
          onProgress: (progress) => args.report(attachment.id, progress.percent),
        });
        ready = fileResult;
      }
      throwIfSendAborted(args.signal);
      if (args.content.mode === 'protected') assertProtectedAttachmentReferences([ready]);
      if (ready.type === 'image') {
        try {
          await seedSessionImageCache(
            {
              workspaceId: args.record.workspaceId as WorkspaceId,
              sessionId: args.record.sessionId,
              imageId: ready.imageId,
              localImageId: ready.localImageId,
              storageSessionId: ready.storageSessionId,
              transport: ready.transport,
              machineId: ready.machineId,
            },
            attachment.source,
            isNativeIOSAppShell(),
            args.signal
          );
        } catch (error) {
          // A preview cache failure cannot turn an accepted upload into a retry.
          console.warn('Uploaded image preview cache unavailable', error);
        }
        throwIfSendAborted(args.signal);
      }
      attachments = attachments.map((item) =>
        item.id === attachment.id ? { ...item, ready, error: undefined, progress: 100 } : item
      );
      args.update(attachments);
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
      args.update(attachments);
    }
  }
  if (failure) throw failure;
  return finalizePreparedSend({ ...args.record, attachments });
}

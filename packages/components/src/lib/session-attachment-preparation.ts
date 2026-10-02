import {
  inputBlocksToHistoryItems,
  normalizeSessionInputBlocks,
  SESSION_FILE_MAX_COUNT,
  type MachineId,
  type SessionId,
  type WorkspaceId,
  type SessionInputBlock,
} from '@lody/shared';
import { prepareSessionFile } from './session-file-preparation';
import { uploadSessionImage } from './session-image-upload';
import { isUploadAbortedError } from './session-file-upload';
import {
  canUseElectronLocalFileSend,
  sendSessionFileToLocalRuntime,
} from './electron-session-file-sender';
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
  record: DraftAttachmentSend;
  resources: SessionSendResources;
  signal: AbortSignal;
  token(): string | null;
  localMachineId(): MachineId | null;
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
      if (attachment.kind === 'image') {
        const token = args.token();
        if (!token) throw new Error('Image upload requires authentication');
        try {
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
        } catch (error) {
          throwIfSendAborted(args.signal);
          const machineId = args.record.targetMachineId;
          const fileCount =
            normalizeSessionInputBlocks(args.record.entry.inputConfig?.inputBlocks, '').filter(
              (block) => block.type === 'file'
            ).length +
            attachments.filter((item) => item.kind === 'file' || item.ready?.type === 'file')
              .length;
          // Keep the existing same-machine image fallback. Cancellation, remote
          // targets and a full file allowance never authorize a local transfer.
          if (
            isUploadAbortedError(error) ||
            !machineId ||
            machineId !== args.localMachineId() ||
            !canUseElectronLocalFileSend() ||
            fileCount >= SESSION_FILE_MAX_COUNT
          )
            throw error;
          try {
            const outcome = await args.resources.run(
              (signal) =>
                sendSessionFileToLocalRuntime({
                  workspaceId: args.record.workspaceId,
                  sessionId: args.record.sessionId,
                  machineId,
                  file,
                  signal,
                }),
              args.signal
            );
            if (!outcome?.ok || !outcome.files[0]) throw error;
            ready = outcome.files[0];
          } catch {
            throwIfSendAborted(args.signal);
            // The original upload failure remains the reason if local handoff
            // is also unavailable. No second cloud file upload is introduced.
            throw error;
          }
        }
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
      if (ready.type === 'image') {
        try {
          await seedSessionImageCache(
            {
              workspaceId: args.record.workspaceId as WorkspaceId,
              sessionId: args.record.sessionId,
              imageId: ready.imageId,
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

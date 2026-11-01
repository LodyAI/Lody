import { authorizePlaintextAttachmentPreparation } from './attachment-workspace-access';
import { uploadProtectedAttachment } from './encrypted-session-attachment';
import { requireWorkspaceFeature } from '@/lib/workspace-feature';
import { type WorkspaceStreamsMode } from '@lody/shared/workspace-streams-content';
import type { MachineId, SessionFilePayload, SessionId, WorkspaceId } from '@lody/shared';
import { sendSessionFileToLocalRuntime } from './electron-session-file-sender';
import {
  computeSha256Hex,
  computeTextPreviewable,
  uploadSessionFile,
  type SessionFileUploadProgress,
} from './session-file-upload';
import { throwIfSendAborted, type SessionSendResources } from './session-send-resources';

export class SessionFilePreparationAuthError extends Error {
  constructor() {
    super('Missing workspace or auth token');
    this.name = 'SessionFilePreparationAuthError';
  }
}

/** One transfer path for landing and continuation; UI only observes its result. */
export function prepareSessionFile(
  resources: SessionSendResources,
  args: {
    content: WorkspaceStreamsMode;
    accountId?: string;
    attachmentToken?: () => Promise<string>;
    workspaceId: WorkspaceId;
    sessionId: SessionId;
    machineId: MachineId | null;
    canSendLocally: boolean;
    token: string | null;
    file: File;
    signal?: AbortSignal;
    onProgress?: (progress: SessionFileUploadProgress) => void;
  }
): Promise<SessionFilePayload> {
  return resources.run(async (signal) => {
    if (args.content.mode !== 'protected')
      await authorizePlaintextAttachmentPreparation(args.workspaceId, signal, args.accountId);
    if (args.content.mode !== 'protected' && args.canSendLocally && args.machineId) {
      try {
        const result = await sendSessionFileToLocalRuntime({
          ...args,
          machineId: args.machineId,
          signal,
        });
        throwIfSendAborted(signal);
        if (result?.ok && result.files[0]) return result.files[0];
      } catch (error) {
        // Preserve the existing transport fallback, but cancellation never
        // authorizes a second transfer after a late local handoff.
        throwIfSendAborted(signal);
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
      }
    }
    throwIfSendAborted(signal);
    requireWorkspaceFeature(args.content, 'attachments');
    if (!args.token) throw new SessionFilePreparationAuthError();
    const progress = (value: SessionFileUploadProgress) => {
      if (!signal.aborted) args.onProgress?.(value);
    };
    if (args.content.mode === 'protected') {
      const { encryption, sha256 } = await uploadProtectedAttachment({
        ...args,
        kind: 'file',
        signal,
        onProgress: (percent) =>
          progress({
            phase: 'uploading',
            percent,
            loadedBytes: Math.round((args.file.size * percent) / 100),
            totalBytes: args.file.size,
          }),
      });
      const fileId = encryption.parts[0];
      if (!fileId) throw new Error('Invalid encrypted attachment receipt');
      return {
        type: 'file',
        fileId,
        fileName: args.file.name,
        mimeType: args.file.type || 'application/octet-stream',
        sizeBytes: args.file.size,
        sha256,
        textPreview: await computeTextPreviewable(args.file),
        transport: 'r2',
        uploadedAt: Date.now(),
        encryption,
      };
    }
    const [hash, preview] = await Promise.allSettled([
      computeSha256Hex(args.file, { signal, onProgress: progress }),
      computeTextPreviewable(args.file),
    ]);
    throwIfSendAborted(signal);
    if (hash.status === 'rejected') throw hash.reason;
    if (preview.status === 'rejected') throw preview.reason;
    return await uploadSessionFile({
      accountId: args.accountId,
      content: args.content,
      workspaceId: args.workspaceId,
      sessionId: args.sessionId,
      token: args.token,
      file: args.file,
      sha256: hash.value,
      textPreview: preview.value,
      signal,
      onProgress: progress,
    });
  }, args.signal);
}

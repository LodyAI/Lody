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
    if (args.canSendLocally && args.machineId) {
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
    if (!args.token) throw new SessionFilePreparationAuthError();
    const progress = (value: SessionFileUploadProgress) => {
      if (!signal.aborted) args.onProgress?.(value);
    };
    const [hash, preview] = await Promise.allSettled([
      computeSha256Hex(args.file, { signal, onProgress: progress }),
      computeTextPreviewable(args.file),
    ]);
    throwIfSendAborted(signal);
    if (hash.status === 'rejected') throw hash.reason;
    if (preview.status === 'rejected') throw preview.reason;
    return await uploadSessionFile({
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

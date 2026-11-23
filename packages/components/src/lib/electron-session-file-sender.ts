import { throwIfSendAborted } from './session-send-resources';
import type { SessionFilePayload } from '@lody/shared';
import { isElectronRenderer } from './electron';
import { getIpcServices } from './electron-ipc-client';

/**
 * Desktop local-transport file sender (renderer side).
 *
 * When the desktop app sends files to a session whose runtime is the local CLI,
 * we hand the bytes directly to that CLI (zero relay round trip) instead of
 * uploading to R2. The CLI stores each file in its local blob store and returns
 * `transport: 'local'` blocks; the composer then attaches those blocks to the
 * outgoing message exactly like cloud-uploaded blocks (the CLI does NOT append
 * history itself), and the CLI backfills the bytes to R2 in the background.
 *
 * Returns `null` when the local path is unavailable (not Electron, no preload
 * API), so callers fall back to the cloud upload path.
 */

export const canUseElectronLocalFileSend = (): boolean =>
  isElectronRenderer() && Boolean(getIpcServices());

export type SendSessionFileLocalOutcome =
  | { ok: true; files: SessionFilePayload[]; message?: string }
  | { ok: false; error: string };

const fileToArrayBuffer = async (file: File): Promise<ArrayBuffer> => {
  // `File.arrayBuffer()` is structured-clone-transferable across the IPC bridge,
  // so the bytes are not base64/JSON-encoded.
  return await file.arrayBuffer();
};

/**
 * Hand a single file to the local CLI for a same-machine session. Returns `null`
 * if the local path is unavailable (caller should fall back to cloud upload).
 */
export const sendSessionFileToLocalRuntime = async (args: {
  workspaceId: string;
  sessionId: string;
  machineId: string;
  file: File;
  signal?: AbortSignal;
}): Promise<SendSessionFileLocalOutcome | null> => {
  throwIfSendAborted(args.signal);
  if (!getIpcServices()) {
    return null;
  }
  const bytes = await fileToArrayBuffer(args.file);
  throwIfSendAborted(args.signal);
  const result = await getIpcServices()!.localProjects.sendSessionFileLocal({
    workspaceId: args.workspaceId,
    sessionId: args.sessionId,
    machineId: args.machineId,
    files: [{ fileName: args.file.name, bytes }],
  });
  throwIfSendAborted(args.signal);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  const file = result.files[0];
  if (!file) {
    return { ok: false, error: 'local_handoff_empty' };
  }
  return { ok: true, files: result.files, ...(result.message ? { message: result.message } : {}) };
};

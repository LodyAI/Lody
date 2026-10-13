import type { SessionAttachmentDraft } from '@/lib/session-attachment-draft';
import { getSessionRoomId, isLoroRepoDocDeleted } from '@lody/shared';
import type { MachineId, SessionHistory, SessionId, SessionMeta } from '@lody/shared';
import type { WorkspaceRuntime } from '../atoms/runtime';
import { finalizePreparedSend } from './session-attachment-preparation';
import { prepareUserTurnWrite, writeUserTurn, type SessionSendDelivery } from './session-send-delivery';

/**
 * Every user-message entry point shares this admission. A ready send is written
 * locally before it resolves (`written`). A send with attachments still to
 * prepare, or one behind such a send in the same conversation, is held in the
 * runtime's in-memory queue (`pending`) and written, then delivered, when its
 * turn comes; callers must not dispatch or steer it themselves.
 */
export async function acceptSessionUserTurn(
  runtime: WorkspaceRuntime,
  sessionId: SessionId,
  entry: SessionHistory,
  delivery: SessionSendDelivery,
  creation?: SessionMeta,
  queue?: Record<string, unknown>,
  attachments?: SessionAttachmentDraft[],
  onAccepted?: () => void
): Promise<'written' | 'pending'> {
  const pending = runtime.pendingSends;
  const unprepared = attachments?.some((attachment) => !attachment.ready) ?? false;
  const found = creation ? undefined : await runtime.repo.getDocMeta(getSessionRoomId(sessionId));
  if (isLoroRepoDocDeleted(found)) throw new Error('Target conversation was deleted');
  const meta = creation ?? (found?.meta as SessionMeta | undefined);
  const roostBackend = meta?.historyBackend === 'roost';
  // Opening the new conversation acquires its backend immediately. Publish
  // routing metadata locally before its first row can mount a history store.
  if (roostBackend && creation) await prepareUserTurnWrite(runtime, { sessionId, entry, delivery, creation });
  if (pending && (unprepared || pending.hasSession(sessionId) || roostBackend)) {
    let targetMachineId = creation?.machineId;
    if (!targetMachineId) {
      targetMachineId = (found?.meta as SessionMeta | undefined)?.machineId;
    }
    const prepared = !unprepared && attachments?.length
      ? finalizePreparedSend({ workspaceId: runtime.workspaceId, sessionId, entry, queue, attachments })
      : { entry, queue };
    pending.enqueue({
      id: entry.id,
      sessionId,
      workspaceId: runtime.workspaceId,
      entry: prepared.entry,
      delivery,
      creation,
      queue: prepared.queue,
      attachments: attachments ?? [],
      targetMachineId: targetMachineId as MachineId | undefined,
      historyBackend: meta?.historyBackend === 'roost' ? 'roost' : 'loro',
    });
    onAccepted?.();
    return 'pending';
  }
  if (roostBackend) throw new Error('Local input acceptance is unavailable');
  if (unprepared) throw new Error('Attachments cannot be sent in this workspace');
  const prepared = attachments?.length
    ? finalizePreparedSend({
        workspaceId: runtime.workspaceId,
        sessionId,
        entry,
        queue,
        attachments,
      })
    : { entry, queue };
  await writeUserTurn(runtime, {
    sessionId,
    entry: prepared.entry,
    delivery,
    creation,
    queue: prepared.queue,
  });
  onAccepted?.();
  return 'written';
}

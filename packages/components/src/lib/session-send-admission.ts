import { requireWorkspaceFeature } from './workspace-feature';
import type { SessionAttachmentDraft } from '@/lib/session-attachment-draft';
import {
  getMachineRoomId,
  normalizeSessionInputBlocks,
  getSessionRoomId,
  isLoroRepoDocDeleted,
  machineSupportsSessionInputDispatch,
  type MachineMeta,
} from '@lody/shared';
import i18next from 'i18next';
import { SessionInputNotSentError } from './session-accepted-inputs';
import type { MachineId, SessionHistory, SessionId, SessionMeta } from '@lody/shared';
import type { WorkspaceRuntime } from '../atoms/runtime';
import { finalizePreparedSend } from './session-attachment-preparation';
import {
  prepareUserTurnWrite,
  writeUserTurn,
  type SessionSendDelivery,
} from './session-send-delivery';

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
  if (
    attachments?.some(
      (attachment) =>
        !attachment.ready ||
        attachment.ready.type !== 'file' ||
        attachment.ready.transport !== 'local'
    )
  ) {
    requireWorkspaceFeature(
      { mode: runtime.contentMode === 'e2ee' ? 'protected' : 'plaintext' },
      'attachments'
    );
  }
  if (runtime.contentMode === 'e2ee') {
    const blocks = normalizeSessionInputBlocks(entry.inputConfig?.inputBlocks, '');
    for (const ready of [...blocks, ...(attachments?.flatMap((item) => item.ready ? [item.ready] : []) ?? [])]) {
      if ((ready.type === 'image' || (ready.type === 'file' && ready.transport !== 'local')) && !ready.encryption)
        throw new Error('e2ee_attachment_unprotected');
    }
  }
  const pending = runtime.pendingSends;
  const unprepared = attachments?.some((attachment) => !attachment.ready) ?? false;
  const found = creation ? undefined : await runtime.repo.getDocMeta(getSessionRoomId(sessionId));
  if (isLoroRepoDocDeleted(found)) throw new Error('Target conversation was deleted');
  const meta = creation ?? (found?.meta as SessionMeta | undefined);
  const roostBackend = meta?.historyBackend === 'roost';
  if (runtime.contentMode === 'e2ee' && roostBackend)
    throw new Error('e2ee_history_backend_unavailable');
  if (pending && (unprepared || pending.hasSession(sessionId) || roostBackend)) {
    let targetMachineId = creation?.machineId;
    if (!targetMachineId) {
      targetMachineId = (found?.meta as SessionMeta | undefined)?.machineId;
    }
    if (roostBackend && delivery.kind === 'dispatch') {
      const machine = targetMachineId
        ? await runtime.repo.getDocMeta(getMachineRoomId(targetMachineId))
        : undefined;
      if (!machineSupportsSessionInputDispatch(machine?.meta as MachineMeta | undefined))
        throw new SessionInputNotSentError(i18next.t('sessions.inputOwnerNeedsUpdate'));
    }
    // Publish routing before a row can acquire its backend, after capability
    // refusal so an older owner cannot consume the draft or create an empty session.
    if (roostBackend && creation)
      await prepareUserTurnWrite(runtime, { sessionId, entry, delivery, creation });
    const prepared =
      !unprepared && attachments?.length
        ? finalizePreparedSend({
            workspaceId: runtime.workspaceId,
            sessionId,
            entry,
            queue,
            attachments,
          })
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

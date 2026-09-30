import type { PendingSessionSend } from './session-pending-sends';

export type SessionSendState = 'sending' | 'failed';

/** Renderer-local projection of the in-memory pending sends of one session; never synced. */
export type SessionSendStatus = {
  state: SessionSendState;
  /** 0–100 across every held message of the session. */
  progress: number;
  sentBytes: number;
  totalBytes: number;
  /** A new conversation whose first message has not been written yet. */
  unsentNewConversation: boolean;
};

type Attachment = PendingSessionSend['attachments'][number];

function attachmentBytes(attachment: Attachment): number {
  if (attachment.source) return attachment.source.size;
  const ready = attachment.ready as { sizeBytes?: unknown } | undefined;
  return typeof ready?.sizeBytes === 'number' ? ready.sizeBytes : 0;
}

function attachmentSentBytes(attachment: Attachment): number {
  const total = attachmentBytes(attachment);
  if (attachment.ready) return total;
  const progress = Math.min(100, Math.max(0, attachment.progress ?? 0));
  return (total * progress) / 100;
}

function sendBytes(send: PendingSessionSend) {
  let totalBytes = 0;
  let sentBytes = 0;
  for (const attachment of send.attachments) {
    totalBytes += attachmentBytes(attachment);
    sentBytes += attachmentSentBytes(attachment);
  }
  return { totalBytes, sentBytes };
}

/** Without measurable bytes, a held message sits at the start of its ring. */
const WAITING_PROGRESS = 5;

function progressOf(sentBytes: number, totalBytes: number) {
  return totalBytes > 0
    ? Math.min(99, Math.round((sentBytes / totalBytes) * 100))
    : WAITING_PROGRESS;
}

export type SessionSendProgress = {
  state: SessionSendState;
  /** 0–100 from attachment bytes when measurable. */
  progress: number;
  sentBytes: number;
  totalBytes: number;
};

/** One held message's own status, for surfaces that list messages separately. */
export function deriveSessionSendProgress(
  send: PendingSessionSend
): SessionSendProgress {
  const { totalBytes, sentBytes } = sendBytes(send);
  return {
    state: send.error ? 'failed' : 'sending',
    progress: progressOf(sentBytes, totalBytes),
    sentBytes: Math.round(sentBytes),
    totalBytes,
  };
}

/**
 * A queue-bound message was routed to the queue because the Agent was busy. Until
 * it is written it must not exist as an executable queue row, so it is SHOWN in
 * the queue sheet rather than the conversation stream, where it would otherwise
 * jump into the queue once its upload finished.
 */
export function isQueueBoundSend(send: PendingSessionSend): boolean {
  return Boolean(send.queue);
}

/**
 * The local rows the queue sheet draws below the real queue, in send order. A
 * send whose queue item is already in the synced queue is hidden, so the two
 * never render together.
 */
export function selectPendingQueueSends(
  sends: readonly PendingSessionSend[],
  sessionId: string,
  queuedTurnIds: ReadonlySet<string>
): PendingSessionSend[] {
  return sends.filter(
    (send) => send.sessionId === sessionId && isQueueBoundSend(send) && !queuedTurnIds.has(send.id)
  );
}

export function deriveSessionSendStatuses(
  sends: readonly PendingSessionSend[]
): Record<string, SessionSendStatus> {
  const bySession = new Map<string, PendingSessionSend[]>();
  for (const send of sends) {
    const list = bySession.get(send.sessionId);
    if (list) list.push(send);
    else bySession.set(send.sessionId, [send]);
  }
  const statuses: Record<string, SessionSendStatus> = {};
  for (const [sessionId, list] of bySession) {
    let totalBytes = 0;
    let sentBytes = 0;
    let failed = false;
    let unsentNewConversation = false;
    for (const send of list) {
      if (send.error) failed = true;
      if (send.creation) unsentNewConversation = true;
      const bytes = sendBytes(send);
      totalBytes += bytes.totalBytes;
      sentBytes += bytes.sentBytes;
    }
    statuses[sessionId] = {
      state: failed ? 'failed' : 'sending',
      progress: progressOf(sentBytes, totalBytes),
      sentBytes: Math.round(sentBytes),
      totalBytes,
      unsentNewConversation,
    };
  }
  return statuses;
}

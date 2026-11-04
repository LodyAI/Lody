/**
 * The user-facing shape of one Session continuation. The Host owns the real
 * wait/receipt ledger; this view is what a conversation surface is allowed to
 * say out loud. It deliberately has no program, evidence or check counters:
 * those turn the note back into a control panel.
 */
export type SessionContinuationPhase =
  | 'waiting'
  | 'matched'
  | 'failed'
  | 'expired'
  | 'cancelled'
  | 'unknown';

export type SessionContinuationBlock = 'stopped' | 'permission' | 'offline' | 'unavailable';

export type SessionContinuationDelivery = 'queued' | 'running' | 'blocked' | 'settled' | 'unknown';

export type SessionContinuationTone = 'calm' | 'active' | 'attention';

export type SessionContinuationDetail =
  | 'waiting'
  | 'waitingOffline'
  | 'queued'
  | 'running'
  | 'blockedStopped'
  | 'blockedPermission'
  | 'blockedOffline'
  | 'blockedUnavailable'
  | 'deliveryUnknown'
  | 'failed'
  | 'sourceUnknown';

export type SessionContinuationNextCheck =
  | { kind: 'soon' }
  | { kind: 'relative'; unit: 'second' | 'minute' | 'hour'; count: number }
  | { kind: 'absolute'; at: number };

export type SessionContinuationActions = {
  cancel: boolean;
  resume: boolean;
  askAgent: boolean;
};

export type SessionContinuationView = {
  id: string;
  /** The Agent's own sentence. Empty means the note falls back to a generic title. */
  reason: string;
  phase: SessionContinuationPhase;
  nextCheckAt?: number;
  checkedAt?: number;
  expiresAt?: number;
  continuation?: SessionContinuationDelivery;
  block?: SessionContinuationBlock;
};

export type SessionContinuationDescriptor =
  | { visible: false }
  | {
      visible: true;
      tone: SessionContinuationTone;
      title: string | null;
      detail: SessionContinuationDetail;
      nextCheck?: SessionContinuationNextCheck;
      actions: SessionContinuationActions;
    };

const NOW_SOON_MS = 5_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export function nextCheckFor(at: number, now: number): SessionContinuationNextCheck {
  const remaining = at - now;
  if (remaining <= NOW_SOON_MS) return { kind: 'soon' };
  if (remaining < MINUTE_MS)
    return { kind: 'relative', unit: 'second', count: Math.max(1, Math.round(remaining / 1_000)) };
  if (remaining < HOUR_MS)
    return {
      kind: 'relative',
      unit: 'minute',
      count: Math.max(1, Math.round(remaining / MINUTE_MS)),
    };
  if (remaining < DAY_MS)
    return { kind: 'relative', unit: 'hour', count: Math.max(1, Math.round(remaining / HOUR_MS)) };
  return { kind: 'absolute', at };
}

function titleFor(view: SessionContinuationView): string | null {
  const title = view.reason.trim();
  return title.length > 0 ? title : null;
}

function nextCheck(
  view: SessionContinuationView,
  now: number
): SessionContinuationNextCheck | undefined {
  return view.phase === 'waiting' && view.nextCheckAt !== undefined
    ? nextCheckFor(view.nextCheckAt, now)
    : undefined;
}

/**
 * Collapses the Host's wait + continuation states into the six things a person
 * can act on. There is no `completed` here on purpose: `settled` leaves the note
 * entirely, and an uncertain delivery is never announced as success.
 */
export function describeSessionContinuation(
  view: SessionContinuationView,
  now: number
): SessionContinuationDescriptor {
  const title = titleFor(view);

  if (view.phase === 'expired' || view.phase === 'cancelled') return { visible: false };

  if (view.phase === 'failed') {
    return {
      visible: true,
      tone: 'attention',
      title,
      detail: 'failed',
      actions: { cancel: true, resume: false, askAgent: true },
    };
  }

  if (view.phase === 'unknown') {
    return {
      visible: true,
      tone: 'calm',
      title,
      detail: 'sourceUnknown',
      actions: { cancel: true, resume: false, askAgent: false },
    };
  }

  if (view.phase === 'waiting') {
    if (view.block === 'offline') {
      return {
        visible: true,
        tone: 'calm',
        title,
        detail: 'waitingOffline',
        nextCheck: nextCheck(view, now),
        actions: { cancel: true, resume: false, askAgent: false },
      };
    }
    if (view.block === 'unavailable') {
      return {
        visible: true,
        tone: 'calm',
        title,
        detail: 'sourceUnknown',
        actions: { cancel: true, resume: false, askAgent: false },
      };
    }
    return {
      visible: true,
      tone: 'calm',
      title,
      detail: 'waiting',
      nextCheck: nextCheck(view, now),
      actions: { cancel: true, resume: false, askAgent: false },
    };
  }

  switch (view.block) {
    case 'stopped':
      return {
        visible: true,
        tone: 'attention',
        title,
        detail: 'blockedStopped',
        actions: { cancel: true, resume: true, askAgent: false },
      };
    case 'permission':
      return {
        visible: true,
        tone: 'attention',
        title,
        detail: 'blockedPermission',
        actions: { cancel: true, resume: false, askAgent: false },
      };
    case 'offline':
      return {
        visible: true,
        tone: 'attention',
        title,
        detail: 'blockedOffline',
        actions: { cancel: true, resume: false, askAgent: false },
      };
    case 'unavailable':
      return {
        visible: true,
        tone: 'attention',
        title,
        detail: 'blockedUnavailable',
        actions: { cancel: true, resume: false, askAgent: false },
      };
  }

  switch (view.continuation) {
    case 'settled':
      return { visible: false };
    case 'running':
      return {
        visible: true,
        tone: 'active',
        title,
        detail: 'running',
        actions: { cancel: false, resume: false, askAgent: false },
      };
    case 'unknown':
      return {
        visible: true,
        tone: 'active',
        title,
        detail: 'deliveryUnknown',
        actions: { cancel: false, resume: false, askAgent: true },
      };
    case 'blocked':
      return {
        visible: true,
        tone: 'attention',
        title,
        detail: 'blockedUnavailable',
        actions: { cancel: true, resume: false, askAgent: false },
      };
    case 'queued':
    default:
      return {
        visible: true,
        tone: 'active',
        title,
        detail: 'queued',
        actions: { cancel: true, resume: false, askAgent: false },
      };
  }
}

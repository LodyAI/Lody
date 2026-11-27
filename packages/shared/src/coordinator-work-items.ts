import { z } from 'zod';
import { extractLinkedSessionIdsFromText } from './coordinator-threads';

export const WORK_ITEM_ID_MAX_CHARS = 128;
export const WORK_ITEM_TITLE_MAX_CHARS = 160;
export const WORK_ITEM_SUMMARY_MAX_CHARS = 320;
export const WORK_ITEM_PROGRESS_NOTE_MAX_CHARS = 280;
export const WORK_ITEM_PENDING_ACTION_MAX_CHARS = 180;
export const WORK_ITEM_ROLE_MAX_CHARS = 48;
export const WORK_ITEM_EXTERNAL_REFS_MAX_COUNT = 16;
export const WORK_ITEM_EXTERNAL_REF_KIND_MAX_CHARS = 48;
export const WORK_ITEM_EXTERNAL_REF_URI_MAX_CHARS = 512;
export const WORK_ITEM_EXTERNAL_REF_LABEL_MAX_CHARS = 120;
export const WORK_ITEM_MEMBERS_MAX_COUNT = 32;
export const COORDINATOR_WORK_ITEMS_MAX_COUNT = 500;
export const COORDINATOR_CARD_SNAPSHOT_SESSIONS_MAX_COUNT = 32;
export const COORDINATOR_CARD_SNAPSHOT_TURN_ID_MAX_CHARS = 160;

export const CoordinatorCollaborationModeSchema = z.enum(['delegated', 'direct']);
export type CoordinatorCollaborationMode = z.infer<typeof CoordinatorCollaborationModeSchema>;

export const CoordinatorWorkItemStageSchema = z.enum([
  'proposed',
  'working',
  'blocked',
  'review',
  'done',
]);
export type CoordinatorWorkItemStage = z.infer<typeof CoordinatorWorkItemStageSchema>;

export const CoordinatorExternalRefSchema = z
  .object({
    kind: z.string().trim().min(1).max(WORK_ITEM_EXTERNAL_REF_KIND_MAX_CHARS),
    uri: z.string().trim().min(1).max(WORK_ITEM_EXTERNAL_REF_URI_MAX_CHARS),
    label: z.string().trim().max(WORK_ITEM_EXTERNAL_REF_LABEL_MAX_CHARS).optional(),
  })
  .strict();

export type CoordinatorExternalRef = z.infer<typeof CoordinatorExternalRefSchema>;

export type CoordinatorWorkItemDoc = {
  id: string;
  taskNumber?: number;
  title?: string;
  stage?: CoordinatorWorkItemStage;
  summary?: string;
  progressNote?: string;
  pendingAction?: string;
  mode?: CoordinatorCollaborationMode;
  externalRefs?: CoordinatorExternalRef[];
  acceptedAt?: number;
  archivedAt?: number;
  createdAt: number;
  updatedAt: number;
};

const WORK_ITEM_ID_PATTERN = /^[a-zA-Z0-9_.:-]{1,128}$/;

export function normalizeWorkItemId(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const extractedSession = extractLinkedSessionIdsFromText(trimmed)[0];
  const candidate = extractedSession ?? trimmed;
  if (candidate.length > WORK_ITEM_ID_MAX_CHARS || !WORK_ITEM_ID_PATTERN.test(candidate)) {
    return undefined;
  }
  return candidate;
}

export function normalizeWorkItemRole(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.replace(/\s+/g, ' ').trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, WORK_ITEM_ROLE_MAX_CHARS);
}

export function normalizeCoordinatorExternalRefs(raw: unknown): CoordinatorExternalRef[] {
  if (!Array.isArray(raw)) return [];
  const out: CoordinatorExternalRef[] = [];
  const seenUris = new Set<string>();
  for (const item of raw) {
    if (out.length >= WORK_ITEM_EXTERNAL_REFS_MAX_COUNT) break;
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const kind =
      typeof rec.kind === 'string' && rec.kind.trim().length > 0
        ? rec.kind.trim().slice(0, WORK_ITEM_EXTERNAL_REF_KIND_MAX_CHARS)
        : undefined;
    const uri =
      typeof rec.uri === 'string' && rec.uri.trim().length > 0
        ? rec.uri.trim().slice(0, WORK_ITEM_EXTERNAL_REF_URI_MAX_CHARS)
        : undefined;
    if (!kind || !uri) continue;
    const dedupKey = uri.toLowerCase();
    if (seenUris.has(dedupKey)) continue;
    seenUris.add(dedupKey);
    const label =
      typeof rec.label === 'string' && rec.label.trim().length > 0
        ? rec.label.replace(/\s+/g, ' ').trim().slice(0, WORK_ITEM_EXTERNAL_REF_LABEL_MAX_CHARS)
        : undefined;
    out.push({
      kind,
      uri,
      ...(label ? { label } : {}),
    });
  }
  return out;
}

export function normalizeCoordinatorWorkItemDoc(
  raw: unknown,
  fallbackId?: string
): CoordinatorWorkItemDoc | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  const id = normalizeWorkItemId(rec.id) ?? normalizeWorkItemId(fallbackId);
  if (!id) return undefined;
  const createdAt =
    typeof rec.createdAt === 'number' && Number.isFinite(rec.createdAt) && rec.createdAt > 0
      ? rec.createdAt
      : 0;
  const updatedAt =
    typeof rec.updatedAt === 'number' && Number.isFinite(rec.updatedAt) && rec.updatedAt > 0
      ? rec.updatedAt
      : createdAt;
  const title =
    typeof rec.title === 'string' && rec.title.trim().length > 0
      ? rec.title.replace(/\s+/g, ' ').trim().slice(0, WORK_ITEM_TITLE_MAX_CHARS)
      : undefined;
  const stageParsed = CoordinatorWorkItemStageSchema.safeParse(rec.stage);
  const summary =
    typeof rec.summary === 'string' && rec.summary.trim().length > 0
      ? rec.summary.replace(/\s+/g, ' ').trim().slice(0, WORK_ITEM_SUMMARY_MAX_CHARS)
      : undefined;
  const progressNote =
    typeof rec.progressNote === 'string' && rec.progressNote.trim().length > 0
      ? rec.progressNote.replace(/\s+/g, ' ').trim().slice(0, WORK_ITEM_PROGRESS_NOTE_MAX_CHARS)
      : undefined;
  const pendingAction =
    typeof rec.pendingAction === 'string' && rec.pendingAction.trim().length > 0
      ? rec.pendingAction.replace(/\s+/g, ' ').trim().slice(0, WORK_ITEM_PENDING_ACTION_MAX_CHARS)
      : undefined;
  const modeParsed = CoordinatorCollaborationModeSchema.safeParse(rec.mode);
  const taskNumber =
    typeof rec.taskNumber === 'number' && Number.isSafeInteger(rec.taskNumber) && rec.taskNumber > 0
      ? rec.taskNumber
      : undefined;
  const acceptedAt =
    typeof rec.acceptedAt === 'number' && Number.isFinite(rec.acceptedAt) && rec.acceptedAt > 0
      ? rec.acceptedAt
      : undefined;
  const archivedAt =
    typeof rec.archivedAt === 'number' && Number.isFinite(rec.archivedAt) && rec.archivedAt > 0
      ? rec.archivedAt
      : undefined;
  const externalRefs = normalizeCoordinatorExternalRefs(rec.externalRefs);
  return {
    id,
    ...(taskNumber !== undefined ? { taskNumber } : {}),
    ...(title ? { title } : {}),
    ...(stageParsed.success ? { stage: stageParsed.data } : {}),
    ...(summary ? { summary } : {}),
    ...(progressNote ? { progressNote } : {}),
    ...(pendingAction ? { pendingAction } : {}),
    ...(modeParsed.success ? { mode: modeParsed.data } : {}),
    ...(externalRefs.length > 0 ? { externalRefs } : {}),
    ...(acceptedAt !== undefined ? { acceptedAt } : {}),
    ...(archivedAt !== undefined ? { archivedAt } : {}),
    createdAt,
    updatedAt,
  };
}

export function normalizeCoordinatorWorkItemsMap(
  raw: unknown
): Record<string, CoordinatorWorkItemDoc> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, CoordinatorWorkItemDoc> = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (count >= COORDINATOR_WORK_ITEMS_MAX_COUNT) break;
    const doc = normalizeCoordinatorWorkItemDoc(value, key);
    if (!doc) continue;
    out[doc.id] = doc;
    count += 1;
  }
  return out;
}

export function normalizeCardSnapshotTurnBySession(
  raw: unknown
): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  let count = 0;
  for (const [rawKey, rawVal] of Object.entries(raw)) {
    if (count >= COORDINATOR_CARD_SNAPSHOT_SESSIONS_MAX_COUNT) break;
    const sessionId = normalizeWorkItemId(rawKey);
    if (!sessionId || typeof rawVal !== 'string') continue;
    out[sessionId] = rawVal.trim().slice(0, COORDINATOR_CARD_SNAPSHOT_TURN_ID_MAX_CHARS);
    count += 1;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export type ChildSessionActivityCursorSnapshot = {
  readonly id: string;
  readonly latestUserMsgId?: string;
  readonly latestMessageAt?: number;
};

/**
 * Determines whether an unchosen coordinator proactive card has been overtaken
 * by direct progression in one of its linked child conversations.
 *
 * Prefers clock-free causal `latestUserMsgId` comparison against
 * `snapshotTurnBySession` captured when the card was authored; falls back to
 * `latestMessageAt` only when no causal turn snapshot was recorded.
 */
export function isCoordinatorCardStaleFromChildActivity(args: {
  readonly snapshotTurnBySession?: Readonly<Record<string, string>>;
  readonly cardCreatedAt?: number;
  readonly linkedSessions: readonly ChildSessionActivityCursorSnapshot[];
  readonly isAlreadyChosen?: boolean;
}): boolean {
  if (args.isAlreadyChosen) return false;
  if (args.linkedSessions.length === 0) return false;
  const snapshots = args.snapshotTurnBySession;
  if (snapshots && Object.keys(snapshots).length > 0) {
    for (const session of args.linkedSessions) {
      if (!Object.prototype.hasOwnProperty.call(snapshots, session.id)) continue;
      const recordedTurnId = snapshots[session.id] ?? '';
      const currentTurnId = session.latestUserMsgId?.trim() ?? '';
      if (currentTurnId !== recordedTurnId) {
        return true;
      }
    }
    return false;
  }
  if (
    typeof args.cardCreatedAt === 'number' &&
    Number.isFinite(args.cardCreatedAt) &&
    args.cardCreatedAt > 0
  ) {
    for (const session of args.linkedSessions) {
      if (
        typeof session.latestMessageAt === 'number' &&
        Number.isFinite(session.latestMessageAt) &&
        session.latestMessageAt > args.cardCreatedAt + 1_000
      ) {
        return true;
      }
    }
  }
  return false;
}

export type CoordinatorWorkItemBucket = 'needsYou' | 'working' | 'review' | 'accepted';

export type CoordinatorWorkItemSessionRef = {
  readonly id: string;
  readonly parentSessionId?: string;
  readonly openedBySessionId?: string;
  readonly openedByRootSessionId?: string;
  readonly workItemId?: string;
  readonly createdAt?: string;
  readonly coordinator?: unknown;
};

export function resolveEffectiveWorkItemId(
  session: Pick<CoordinatorWorkItemSessionRef, 'id' | 'workItemId'>
): string {
  const explicit = session.workItemId?.trim();
  return explicit && explicit.length > 0 ? explicit : session.id;
}

/**
 * Unified membership rule shared across the Project Board, `<project_facts_delta>`,
 * `coordinator.workItems` watch adapter, and group acceptance.
 *
 * A conversation belongs to a coordinator's WorkItem set iff it is a top-level
 * non-coordinator conversation that was either opened by that coordinator OR
 * explicitly bound to one of that coordinator's Blackboard `workItems`.
 */
export function isSessionOwnedByCoordinatorWorkItems(
  session: CoordinatorWorkItemSessionRef,
  coordinatorSessionId: string | null,
  workItems?: Readonly<Record<string, CoordinatorWorkItemDoc>> | null
): boolean {
  if (!coordinatorSessionId) return false;
  if (session.parentSessionId) return false;
  if (session.id === coordinatorSessionId) return false;
  if (session.coordinator) return false;
  if (
    session.openedBySessionId === coordinatorSessionId ||
    session.openedByRootSessionId === coordinatorSessionId
  ) {
    return true;
  }
  const explicitWorkItemId = session.workItemId?.trim();
  return Boolean(explicitWorkItemId && workItems && workItems[explicitWorkItemId]);
}

function workItemSessionCreatedMs(createdAt: string | undefined): number {
  if (!createdAt) return 0;
  const parsed = Date.parse(createdAt);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Single source of truth for stable `T1..Tn` numbering across all `0..N`-member
 * WorkItems (session-backed groups AND standalone Blackboard task cards).
 *
 * Indexes both `workItemId -> number` and `memberSessionId -> number`.
 */
export function resolveCoordinatorWorkItemNumbers(
  sessions: readonly CoordinatorWorkItemSessionRef[],
  coordinatorSessionId: string | null,
  workItems?: Readonly<Record<string, CoordinatorWorkItemDoc>> | null
): Map<string, number> {
  const groups = new Map<string, { earliestMs: number; memberIds: string[] }>();

  for (const session of sessions) {
    if (!isSessionOwnedByCoordinatorWorkItems(session, coordinatorSessionId, workItems)) continue;
    const workItemId = resolveEffectiveWorkItemId(session);
    const ts = workItemSessionCreatedMs(session.createdAt);
    const existing = groups.get(workItemId);
    if (existing) {
      if (ts > 0 && (existing.earliestMs === 0 || ts < existing.earliestMs)) {
        existing.earliestMs = ts;
      }
      existing.memberIds.push(session.id);
    } else {
      const docCreated = workItems?.[workItemId]?.createdAt;
      const initialEarliest =
        ts > 0 ? ts : typeof docCreated === 'number' && docCreated > 0 ? docCreated : 0;
      groups.set(workItemId, { earliestMs: initialEarliest, memberIds: [session.id] });
    }
  }

  for (const [workItemId, doc] of Object.entries(workItems ?? {})) {
    if (groups.has(workItemId)) continue;
    const docCreated = typeof doc?.createdAt === 'number' && doc.createdAt > 0 ? doc.createdAt : 0;
    groups.set(workItemId, { earliestMs: docCreated, memberIds: [] });
  }

  const ordered = [...groups.entries()].sort(
    ([idA, a], [idB, b]) => a.earliestMs - b.earliestMs || idA.localeCompare(idB)
  );
  const result = new Map<string, number>();
  ordered.forEach(([workItemId, group], index) => {
    const explicitNum = workItems?.[workItemId]?.taskNumber;
    const num =
      typeof explicitNum === 'number' && Number.isSafeInteger(explicitNum) && explicitNum > 0
        ? explicitNum
        : index + 1;
    result.set(workItemId, num);
    for (const memberId of group.memberIds) {
      result.set(memberId, num);
    }
  });
  return result;
}

/**
 * Canonical WorkItem state machine deriving both `bucket` and `stage` from a
 * single precedence order so UI badges and board columns never disagree:
 *
 * 1. Needs user (`needsYou`): any member waiting on user, OR coordinator marked
 *    `blocked` (even while sibling squad members keep running), OR `proposed`
 *    awaiting confirmation.
 * 2. Working (`working`): any member actively working, OR standalone `working`.
 * 3. Accepted (`accepted`): for child-backed items, all members accepted/archived
 *    OR `workItemDoc.acceptedAt >= latestMessageAt` (new activity after acceptance
 *    invalidates `accepted` and returns the item to `review`); for standalone items,
 *    `stage === 'done'` or `acceptedAt` present.
 * 4. Review (`review`): default ready-for-review state.
 */
export function deriveCoordinatorWorkItemState(args: {
  workItemDoc?: CoordinatorWorkItemDoc;
  memberBuckets: readonly CoordinatorWorkItemBucket[];
  latestMessageAt: number;
}): { bucket: CoordinatorWorkItemBucket; stage: CoordinatorWorkItemStage } {
  const { workItemDoc, memberBuckets, latestMessageAt } = args;
  const explicitStage = workItemDoc?.stage;

  if (memberBuckets.length === 0) {
    const isDone = explicitStage === 'done' || typeof workItemDoc?.acceptedAt === 'number';
    if (isDone) return { bucket: 'accepted', stage: 'done' };
    if (explicitStage === 'blocked') return { bucket: 'needsYou', stage: 'blocked' };
    if (explicitStage === 'proposed' || workItemDoc?.pendingAction) {
      return { bucket: 'needsYou', stage: 'proposed' };
    }
    if (explicitStage === 'working') return { bucket: 'working', stage: 'working' };
    return { bucket: 'review', stage: 'review' };
  }

  const hasChildNeedsYou = memberBuckets.some((b) => b === 'needsYou');
  const hasChildWorking = memberBuckets.some((b) => b === 'working');
  const allChildAccepted = memberBuckets.every((b) => b === 'accepted');
  const acceptedByTimestamp =
    typeof workItemDoc?.acceptedAt === 'number' && workItemDoc.acceptedAt >= latestMessageAt;

  if (hasChildNeedsYou || explicitStage === 'blocked') {
    return { bucket: 'needsYou', stage: 'blocked' };
  }
  if (explicitStage === 'proposed' && !hasChildWorking) {
    return { bucket: 'needsYou', stage: 'proposed' };
  }
  if (hasChildWorking) {
    return { bucket: 'working', stage: 'working' };
  }
  if (allChildAccepted || acceptedByTimestamp) {
    return { bucket: 'accepted', stage: 'done' };
  }
  return { bucket: 'review', stage: 'review' };
}

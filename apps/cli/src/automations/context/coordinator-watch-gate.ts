import {
  deriveSessionPullRequestReadiness,
  findFreshSessionPresenceState,
  LODY_PRESENCE_TTL_MS,
  normalizeCoordinatorWorkItemsMap,
  resolveSessionPullRequests,
  type CoordinatorExternalRef,
  type CoordinatorWorkItemDoc,
  type LodyPresenceStateMap,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import type {
  AutomationCoordinatorWorkItemsReadParameters,
  AutomationResult,
} from '@lody/shared/automations';
import { listAliveSessionMetas } from '@/lib/command-runtime';
import type { LoroDocumentManager } from '@/lib/loro/doc';
import { pullRequestCheckpointId } from '../sources/pull-requests';
import type { AutomationLedger } from '../storage/ledger';

export const COORDINATOR_WORK_ITEMS_RESOURCE = 'coordinator.workItems';
export const COORDINATOR_WAKE_DEBOUNCE_MS = 4_000;
const MAX_OBSERVED_WORK_ITEMS = 64;

export type ObservedCoordinatorPullRequest = {
  url: string;
  status: 'open' | 'draft' | 'merged' | 'closed';
  readiness: 'y' | 'n' | null;
  ci: string | null;
  mergeable: string | null;
  observation: unknown;
  observedAt: number | null;
};

export type ObservedCoordinatorMember = {
  sessionId: string;
  role: string | null;
  title: string | null;
  status: string | null;
  userViewing: boolean;
  latestInputId: string | null;
  lastHandledInputId: string | null;
  lastMessageAt: number | null;
  quietForMs: number | null;
  awaitingUserSince: number | null;
  archived: boolean;
  stopped: boolean;
  diffStats: { add: number; del: number; files: number | null } | null;
  pullRequests: ObservedCoordinatorPullRequest[];
};

export type ObservedCoordinatorWorkItem = {
  workItemId: string;
  taskNumber: number;
  title: string | null;
  mode: 'delegated' | 'direct';
  accepted: boolean;
  userViewingAnyMember: boolean;
  quietForMs: number | null;
  externalRefs: CoordinatorExternalRef[];
  pullRequests: ObservedCoordinatorPullRequest[];
  members: ObservedCoordinatorMember[];
};

function createdEpochMs(meta: Pick<SessionMeta, 'createdAt'>): number {
  if (!meta.createdAt) return 0;
  const parsed = Date.parse(meta.createdAt);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function resolveWorkItemId(meta: SessionMeta): string {
  const explicit = meta.workItemId?.trim();
  return explicit && explicit.length > 0 ? explicit : meta.id;
}

function collectOwnerViewedSessionIds(
  presenceStates: LodyPresenceStateMap,
  ownerUserId: string,
  now: number
): Set<string> {
  const viewed = new Set<string>();
  for (const state of Object.values(presenceStates)) {
    if (
      state.kind === 'session-viewing' &&
      state.userId === ownerUserId &&
      now - state.updatedAt <= LODY_PRESENCE_TTL_MS
    ) {
      viewed.add(state.sessionId);
    }
  }
  return viewed;
}

/**
 * Reads bounded, owner-scoped `WorkItem` and member `SessionMeta` facts for a
 * coordinator session's `CodeMode` watch predicates.
 */
export async function readCoordinatorWorkItemsSnapshot(args: {
  ledger: AutomationLedger;
  manager: LoroDocumentManager;
  coordinatorMeta: SessionMeta;
  ownerUserId: string;
  parameters: AutomationCoordinatorWorkItemsReadParameters;
  now: number;
}): Promise<ObservedCoordinatorWorkItem[]> {
  const { ledger, manager, coordinatorMeta, ownerUserId, parameters, now } = args;
  const [coordinatorDoc, aliveRows] = await Promise.all([
    manager.getOrCreateSessionDoc(coordinatorMeta.id),
    listAliveSessionMetas(manager),
  ]);
  const docState = await coordinatorDoc.getDocState();
  const workItems = normalizeCoordinatorWorkItemsMap(docState?.workItems);

  const managedMetas = aliveRows
    .map((row) => row.meta)
    .filter((child) => {
      if (!child || child.id === coordinatorMeta.id || child.parentSessionId) return false;
      if (child.userId !== ownerUserId) return false;
      if (child.openedBySessionId === coordinatorMeta.id) return true;
      const wid = child.workItemId?.trim();
      return Boolean(wid && workItems[wid]);
    });

  const presenceStates = manager.getPresenceStates() ?? {};
  const viewedByOwner = collectOwnerViewedSessionIds(presenceStates, ownerUserId, now);

  const grouped = new Map<string, { earliestMs: number; members: SessionMeta[] }>();
  for (const child of managedMetas) {
    const wid = resolveWorkItemId(child);
    const ts = createdEpochMs(child);
    const existing = grouped.get(wid);
    if (existing) {
      if (ts > 0 && (existing.earliestMs === 0 || ts < existing.earliestMs)) {
        existing.earliestMs = ts;
      }
      existing.members.push(child);
    } else {
      const docCreated = workItems[wid]?.createdAt;
      grouped.set(wid, {
        earliestMs: ts > 0 ? ts : typeof docCreated === 'number' && docCreated > 0 ? docCreated : 0,
        members: [child],
      });
    }
  }

  const orderedGroups = [...grouped.entries()].sort(
    ([idA, a], [idB, b]) => a.earliestMs - b.earliestMs || idA.localeCompare(idB)
  );

  const out: ObservedCoordinatorWorkItem[] = [];
  orderedGroups.forEach(([workItemId, group], index) => {
    if (out.length >= MAX_OBSERVED_WORK_ITEMS) return;
    const doc: CoordinatorWorkItemDoc | undefined = workItems[workItemId];
    const taskNumber =
      typeof doc?.taskNumber === 'number' &&
      Number.isSafeInteger(doc.taskNumber) &&
      doc.taskNumber > 0
        ? doc.taskNumber
        : index + 1;

    if (parameters.workItemId && parameters.workItemId !== workItemId) {
      const matchesMember = group.members.some((m) => m.id === parameters.workItemId);
      if (!matchesMember) return;
    }

    const sortedMembers = [...group.members].sort(
      (a, b) => createdEpochMs(a) - createdEpochMs(b) || a.id.localeCompare(b.id)
    );

    const observedMembers: ObservedCoordinatorMember[] = [];
    const prByUrl = new Map<string, ObservedCoordinatorPullRequest>();
    let newestMessageAt: number | null = null;
    let allAccepted = sortedMembers.length > 0;

    for (const child of sortedMembers) {
      const lastMsgAt =
        typeof child.lastMessageAt === 'number' &&
        Number.isFinite(child.lastMessageAt) &&
        child.lastMessageAt > 0
          ? child.lastMessageAt
          : null;
      if (lastMsgAt !== null && (newestMessageAt === null || lastMsgAt > newestMessageAt)) {
        newestMessageAt = lastMsgAt;
      }
      const latestAt = Math.max(lastMsgAt ?? 0, createdEpochMs(child));
      const memberAccepted =
        Boolean(child.isArchived) ||
        (typeof child.coordinatorTaskAcceptedAt === 'number' &&
          child.coordinatorTaskAcceptedAt >= latestAt);
      if (!memberAccepted) allAccepted = false;

      const livePresence = findFreshSessionPresenceState(presenceStates, child.id, now);
      const memberPrs: ObservedCoordinatorPullRequest[] = resolveSessionPullRequests(child).map(
        (pr) => {
          const state = child.pullRequestState?.[pr.url] ?? null;
          const checkpoint = ledger.checkpoint(pullRequestCheckpointId(child.id, pr.url));
          const entry: ObservedCoordinatorPullRequest = {
            url: pr.url,
            status: pr.status,
            readiness: pr.status === 'open' ? deriveSessionPullRequestReadiness(state) : null,
            ci: state?.s ?? null,
            mergeable: state?.m ?? null,
            observation: checkpoint?.data ?? null,
            observedAt: checkpoint?.observedAt ?? null,
          };
          const dedupKey = pr.url.trim().toLowerCase();
          if (!prByUrl.has(dedupKey)) prByUrl.set(dedupKey, entry);
          return entry;
        }
      );

      const diff = child.diffStats?.allChange;
      observedMembers.push({
        sessionId: child.id,
        role: child.workItemRole?.trim() || null,
        title: child.title?.trim() || null,
        status: livePresence?.status.type ?? null,
        userViewing: viewedByOwner.has(child.id),
        latestInputId: child.latestUserMsgId ?? null,
        lastHandledInputId: child.lastHandledUserMsgId ?? null,
        lastMessageAt: lastMsgAt,
        quietForMs: lastMsgAt !== null ? Math.max(0, now - lastMsgAt) : null,
        awaitingUserSince:
          typeof child.awaitingUserSince === 'number' && child.awaitingUserSince > 0
            ? child.awaitingUserSince
            : null,
        archived: Boolean(child.isArchived),
        stopped: Boolean(child.collaborationStopped),
        diffStats: diff ? { add: diff.add, del: diff.del, files: diff.files ?? null } : null,
        pullRequests: memberPrs,
      });
    }

    if (!parameters.includeAccepted && allAccepted) return;

    const leadTitle = sortedMembers[0]?.title?.trim() || null;
    out.push({
      workItemId,
      taskNumber,
      title: doc?.title?.trim() || leadTitle,
      mode: doc?.mode ?? 'delegated',
      accepted: allAccepted,
      userViewingAnyMember: observedMembers.some((m) => m.userViewing),
      quietForMs: newestMessageAt !== null ? Math.max(0, now - newestMessageAt) : null,
      externalRefs: doc?.externalRefs ?? [],
      pullRequests: [...prByUrl.values()],
      members: observedMembers,
    });
  });

  return out;
}

export type CoordinatorWakeGateDecision =
  | { kind: 'pass'; result: AutomationResult }
  | { kind: 'suppress'; reason: 'user_viewing' | 'debounce'; retryDelayMs: number };

function extractTargetHints(payload: unknown): { workItemId?: string; sessionId?: string } {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  const rec = payload as Record<string, unknown>;
  return {
    ...(typeof rec.workItemId === 'string' && rec.workItemId.trim()
      ? { workItemId: rec.workItemId.trim() }
      : {}),
    ...(typeof rec.sessionId === 'string' && rec.sessionId.trim()
      ? { sessionId: rec.sessionId.trim() }
      : {}),
  };
}

/**
 * Stateless physical attention gate applied when a coordinator `CodeMode` watch
 * predicate matches on `coordinator.workItems`:
 *
 * 1. Suppresses premature coordinator wakeups while the owner user is actively
 *    focused on (`session-viewing`) the watched child conversation.
 * 2. Coalesces rapid bursts within `COORDINATOR_WAKE_DEBOUNCE_MS` so back-to-back
 *    child activity settles before waking the coordinator.
 */
export function evaluateCoordinatorWakeGate(args: {
  result: AutomationResult;
  observedSnapshots: readonly ObservedCoordinatorWorkItem[];
  debounceMs?: number;
}): CoordinatorWakeGateDecision {
  const { result, observedSnapshots, debounceMs = COORDINATOR_WAKE_DEBOUNCE_MS } = args;
  if (result === false || observedSnapshots.length === 0) {
    return { kind: 'pass', result };
  }

  const hints = extractTargetHints(result.payload);
  const relevant =
    hints.workItemId || hints.sessionId
      ? observedSnapshots.filter(
          (item) =>
            item.workItemId === hints.workItemId ||
            item.workItemId === hints.sessionId ||
            item.members.some(
              (m) => m.sessionId === hints.sessionId || m.sessionId === hints.workItemId
            )
        )
      : observedSnapshots;

  const targets = relevant.length > 0 ? relevant : observedSnapshots;

  if (targets.some((item) => item.userViewingAnyMember)) {
    return {
      kind: 'suppress',
      reason: 'user_viewing',
      retryDelayMs: debounceMs,
    };
  }

  let shortestRemainingDebounce = 0;
  for (const item of targets) {
    if (item.quietForMs !== null && item.quietForMs < debounceMs) {
      const remaining = Math.max(250, debounceMs - item.quietForMs);
      if (shortestRemainingDebounce === 0 || remaining < shortestRemainingDebounce) {
        shortestRemainingDebounce = remaining;
      }
    }
  }
  if (shortestRemainingDebounce > 0) {
    return {
      kind: 'suppress',
      reason: 'debounce',
      retryDelayMs: shortestRemainingDebounce,
    };
  }

  return { kind: 'pass', result };
}

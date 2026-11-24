import {
  COORDINATOR_CARD_DISMISSED_ACTION_ID,
  LODY_PRESENCE_TTL_MS,
  extractActionLinkedSessionIds,
  extractLinkedSessionIdsFromText,
  findFreshSessionPresenceState,
  isCoordinatorCardStaleFromChildActivity,
  normalizeCoordinatorActionResolutions,
  normalizeCoordinatorActionSpecs,
  normalizeCoordinatorProactiveCard,
  normalizeCoordinatorWorkItemsMap,
  normalizeSessionTurnInputConfig,
  type CoordinatorCardKind,
  type CoordinatorCollaborationMode,
  type CoordinatorDiagnosticsCursorEntry,
  type CoordinatorDiagnosticsOperationEntry,
  type CoordinatorDiagnosticsWaitEntry,
  type CoordinatorExternalRef,
  type LodyPresenceStateMap,
  type MessageContent,
  type SessionCoordinatorDiagnosticsResponse,
  type SessionHistory,
  type SessionHistoryParsed,
  type SessionPullRequestView,
} from '@lody/shared';
import {
  COORDINATOR_CUSTOM_FEEDBACK_ACTION_ID,
  formatCoordinatorBubbleKey,
} from './coordinator-action-engine';
import type { ProjectBoardBucket, ProjectBoardRow } from './project-board-model';

export const OBSERVABILITY_DEBOUNCE_WINDOW_MS = 4_000;

export type ObservabilityTopologyNodeId =
  | 'human'
  | 'workers'
  | 'connectors'
  | 'store'
  | 'reconciler';

export type ObservabilityTopologyEdgeId =
  | 'human_to_store'
  | 'workers_to_store'
  | 'connectors_to_store'
  | 'store_to_ui'
  | 'store_to_gate'
  | 'gate_to_coord'
  | 'coord_to_store'
  | 'store_to_workers';

export type ObservabilityEventLayer = 'coordinator' | 'squads' | 'cards' | 'cursor' | 'wake_gate';

export type ObservabilityEventSeverity = 'normal' | 'highlight' | 'warning' | 'error';

export type CoordinatorTraceEventKind =
  | 'user_turn'
  | 'coordinator_bubble'
  | 'dispatch_tool'
  | 'work_item_tool'
  | 'automation_tool'
  | 'operation_inbox'
  | 'proactive_card'
  | 'card_superseded'
  | 'cursor_delta_injected'
  | 'cursor_lag_pending'
  | 'watch_gate_status'
  | 'external_pr_signal';

export type CoordinatorTraceEvent = {
  readonly id: string;
  readonly timestampMs: number;
  readonly kind: CoordinatorTraceEventKind;
  readonly layer: ObservabilityEventLayer;
  readonly severity: ObservabilityEventSeverity;
  readonly badge: string;
  readonly title: string;
  readonly summary: string;
  readonly detailPayload?: string;
  readonly turnId?: string;
  readonly workItemId?: string;
  readonly taskNumber?: number | null;
  readonly linkedSessionIds: readonly string[];
  readonly activeNodes: readonly ObservabilityTopologyNodeId[];
  readonly activeEdges: readonly ObservabilityTopologyEdgeId[];
};

export type CoordinatorObservabilityCardSnapshotCheck = {
  readonly sessionId: string;
  readonly sessionTitle: string;
  readonly frozenTurnId: string;
  readonly currentTurnId: string | null;
  readonly diverged: boolean;
};

export type CoordinatorObservabilityCardVerdict =
  | 'open'
  | 'chosen'
  | 'dismissed'
  | 'superseded_by_child'
  | 'superseded_by_stream';

export type CoordinatorObservabilityCardAudit = {
  readonly key: string;
  readonly turnId: string;
  readonly bubbleId: string;
  readonly createdAtMs: number;
  readonly kind: CoordinatorCardKind;
  readonly title: string;
  readonly summary?: string;
  readonly workItemId?: string;
  readonly taskNumber?: number | null;
  readonly verdict: CoordinatorObservabilityCardVerdict;
  readonly chosenLabel?: string;
  readonly actionCount: number;
  readonly snapshotChecks: readonly CoordinatorObservabilityCardSnapshotCheck[];
};

export type CoordinatorObservabilityCursorStatus =
  | 'synced'
  | 'pending_turn_delta'
  | 'pending_pr_delta'
  | 'unseeded';

export type CoordinatorObservabilityCursorAudit = {
  readonly sessionId: string;
  readonly sessionTitle: string;
  readonly workItemId: string;
  readonly taskNumber: number | null;
  readonly role?: string;
  readonly mode: CoordinatorCollaborationMode;
  readonly cursorTurnId: string | null;
  readonly liveTurnId: string | null;
  readonly cursorUpdatedAt: number | null;
  readonly liveLastMessageAt: number;
  readonly prCount: number;
  readonly status: CoordinatorObservabilityCursorStatus;
};

export type CoordinatorObservabilityGateVerdict =
  | 'pass_ready'
  | 'suppressed_focus'
  | 'suppressed_debounce'
  | 'waiting_condition'
  | 'matched'
  | 'failed'
  | 'inactive';

export type CoordinatorObservabilityWatchAudit = {
  readonly id: string;
  readonly reason: string;
  readonly program?: string;
  readonly state: string;
  readonly checks: number;
  readonly consecutiveErrors: number;
  readonly lastError?: string;
  readonly nextCheckAt: number;
  readonly nextCheckInMs: number;
  readonly readsCoordinatorWorkItems: boolean;
  readonly gateVerdict: CoordinatorObservabilityGateVerdict;
  readonly viewingSessionIds: readonly string[];
  readonly remainingDebounceMs: number;
  readonly continuationState?: string;
  readonly continuationReason?: string;
};

export type CoordinatorObservabilityWorkItemAudit = {
  readonly workItemId: string;
  readonly taskNumber: number | null;
  readonly title: string;
  readonly mode: CoordinatorCollaborationMode;
  readonly bucket: ProjectBoardBucket;
  readonly memberCount: number;
  readonly members: ReadonlyArray<{
    readonly sessionId: string;
    readonly title: string;
    readonly role?: string;
    readonly bucket: ProjectBoardBucket;
    readonly liveStatus: string | null;
    readonly userViewing: boolean;
    readonly latestUserMsgId?: string;
    readonly quietForMs: number | null;
  }>;
  readonly pullRequests: readonly SessionPullRequestView[];
  readonly externalRefs: readonly CoordinatorExternalRef[];
};

export type CoordinatorObservabilitySnapshot = {
  readonly nowMs: number;
  readonly diagnosticsConnected: boolean;
  readonly metrics: {
    readonly workItemCount: number;
    readonly directWorkItemCount: number;
    readonly memberSessionCount: number;
    readonly activeWorkerCount: number;
    readonly pullRequestCount: number;
    readonly openCardCount: number;
    readonly supersededCardCount: number;
    readonly pendingDeltaCount: number;
    readonly activeWatchCount: number;
    readonly suppressedWatchCount: number;
  };
  readonly liveActiveNodes: ReadonlySet<ObservabilityTopologyNodeId>;
  readonly liveActiveEdges: ReadonlySet<ObservabilityTopologyEdgeId>;
  readonly viewedChildSessionIds: ReadonlySet<string>;
  readonly workItems: readonly CoordinatorObservabilityWorkItemAudit[];
  readonly cards: readonly CoordinatorObservabilityCardAudit[];
  readonly cursorAudits: readonly CoordinatorObservabilityCursorAudit[];
  readonly lastTurnDelta?: {
    readonly userTurnId: string;
    readonly deltaText: string;
    readonly updatedAt: number;
  };
  readonly operations: readonly CoordinatorDiagnosticsOperationEntry[];
  readonly watches: readonly CoordinatorObservabilityWatchAudit[];
  readonly events: readonly CoordinatorTraceEvent[];
};

function toEpochMs(raw: string | number | undefined, fallback: number): number {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

function truncateText(text: string, maxChars: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function extractUserMessageText(msg: SessionHistory | SessionHistoryParsed): string {
  const parts: string[] = [];
  for (const item of msg.items ?? []) {
    if (item.type === 'text' && item.text.trim()) {
      parts.push(item.text.trim());
    }
  }
  if (parts.length > 0) return parts.join(' ');
  const cfg = normalizeSessionTurnInputConfig(msg.inputConfig);
  return cfg?.prompt?.trim() ?? '';
}

function safePrettyJson(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value, null, 2).slice(0, 3200);
  } catch {
    return String(value).slice(0, 1200);
  }
}

function collectToolInputPayload(item: Extract<MessageContent, { type: 'tool_call' }>): unknown {
  const raw = item as unknown as Record<string, unknown>;
  return raw.rawInput ?? raw.args ?? raw.input ?? undefined;
}

function inferToolName(item: Extract<MessageContent, { type: 'tool_call' }>): string {
  const raw = item as unknown as Record<string, unknown>;
  if (typeof raw.toolName === 'string' && raw.toolName.trim()) return raw.toolName.trim();
  if (typeof raw.name === 'string' && raw.name.trim()) return raw.name.trim();
  const title = typeof item.title === 'string' ? item.title.trim() : '';
  const match = /lody_[a-z_]+/iu.exec(title);
  return match?.[0] ?? (title || 'tool_call');
}

function buildPrDigestSignature(prs: readonly SessionPullRequestView[]): string {
  if (prs.length === 0) return '';
  return JSON.stringify(
    prs
      .map((pr) => ({
        url: pr.url.trim().toLowerCase(),
        status: pr.status,
        readiness: pr.readiness ?? '',
        ci: pr.state?.s ?? '',
        merge: pr.state?.m ?? '',
      }))
      .sort((a, b) => a.url.localeCompare(b.url))
  );
}

/**
 * Pure projection assembling the full Coordinator Architecture & Dataflow
 * Observability state from live Loro `SessionHistory`, `WorkItem` board rows,
 * ephemeral workspace presence, and optional local SQLite diagnostics.
 */
export function buildCoordinatorObservabilitySnapshot(args: {
  coordinatorSessionId: string;
  currentUserId: string | null;
  history: readonly (SessionHistory | SessionHistoryParsed)[];
  tasksById: ReadonlyMap<string, ProjectBoardRow>;
  rawWorkItems?: unknown;
  presenceStates?: LodyPresenceStateMap | null;
  supersededCardKeys?: ReadonlySet<string>;
  diagnostics?: SessionCoordinatorDiagnosticsResponse | null;
  fallbackWaits?: ReadonlyArray<{
    id: string;
    reason?: string;
    state: string;
    nextCheckAt: number;
    expiresAt?: number;
    continuation?: { state: string; reason?: string };
  }>;
  nowMs?: number;
}): CoordinatorObservabilitySnapshot {
  const nowMs = args.nowMs ?? Date.now();
  const workItemsMap = normalizeCoordinatorWorkItemsMap(args.rawWorkItems);
  const presence = args.presenceStates ?? {};

  const uniqueWorkItemRows: ProjectBoardRow[] = [];
  const seenWorkItemIds = new Set<string>();
  const sessionTitleById = new Map<string, string>();
  const sessionCurrentTurnById = new Map<string, string | undefined>();
  const sessionRowById = new Map<string, ProjectBoardRow>();

  for (const row of args.tasksById.values()) {
    const wid = row.workItemId || row.session?.id || '';
    if (!wid) continue;
    if (!seenWorkItemIds.has(wid)) {
      seenWorkItemIds.add(wid);
      uniqueWorkItemRows.push(row);
    }
    const members =
      row.members && row.members.length > 0
        ? row.members
        : row.session
          ? [
              {
                session: row.session,
                role: row.session.workItemRole,
                bucket: row.bucket,
                latestMessageAt: row.latestMessageAt,
                hasUnreadMessages: row.hasUnreadMessages,
                pullRequest: row.pullRequest,
                pullRequests: row.pullRequests ?? (row.pullRequest ? [row.pullRequest] : []),
              },
            ]
          : [];
    for (const member of members) {
      sessionRowById.set(member.session.id, row);
      sessionTitleById.set(
        member.session.id,
        member.session.title?.trim() || row.workItemTitle?.trim() || member.session.id
      );
      sessionCurrentTurnById.set(member.session.id, member.session.latestUserMsgId);
    }
  }

  uniqueWorkItemRows.sort(
    (a, b) =>
      (a.taskNumber ?? 9999) - (b.taskNumber ?? 9999) || b.latestMessageAt - a.latestMessageAt
  );

  const viewedChildSessionIds = new Set<string>();
  for (const entry of Object.values(presence)) {
    if (
      entry.kind === 'session-viewing' &&
      (!args.currentUserId || entry.userId === args.currentUserId) &&
      nowMs - entry.updatedAt <= LODY_PRESENCE_TTL_MS &&
      sessionRowById.has(entry.sessionId)
    ) {
      viewedChildSessionIds.add(entry.sessionId);
    }
  }

  let activeWorkerCount = 0;
  let pullRequestCount = 0;
  let shortestChildQuietMs: number | null = null;

  const workItems: CoordinatorObservabilityWorkItemAudit[] = uniqueWorkItemRows.map((row) => {
    const wid = row.workItemId || row.session?.id || '';
    const doc = workItemsMap[wid];
    const prs =
      row.pullRequests && row.pullRequests.length > 0
        ? row.pullRequests
        : row.pullRequest
          ? [row.pullRequest]
          : [];
    pullRequestCount += prs.length;

    const rawMembers =
      row.members && row.members.length > 0
        ? row.members
        : row.session
          ? [
              {
                session: row.session,
                role: row.session.workItemRole,
                bucket: row.bucket,
                isWorking: row.isWorking,
                latestMessageAt: row.latestMessageAt,
                hasUnreadMessages: row.hasUnreadMessages,
                pullRequest: row.pullRequest,
                pullRequests: prs,
              },
            ]
          : [];

    const members = rawMembers.map((m) => {
      const live = findFreshSessionPresenceState(presence, m.session.id, nowMs);
      const liveStatus = live?.status.type ?? (m.isWorking ? 'running' : null);
      if (liveStatus === 'running') activeWorkerCount += 1;
      const lastMsg =
        typeof m.session.lastMessageAt === 'number' && m.session.lastMessageAt > 0
          ? m.session.lastMessageAt
          : null;
      const quietForMs = lastMsg !== null ? Math.max(0, nowMs - lastMsg) : null;
      if (
        quietForMs !== null &&
        (shortestChildQuietMs === null || quietForMs < shortestChildQuietMs)
      ) {
        shortestChildQuietMs = quietForMs;
      }
      return {
        sessionId: m.session.id,
        title: m.session.title?.trim() || m.session.id,
        role: m.role ?? m.session.workItemRole,
        bucket: m.bucket,
        liveStatus,
        userViewing: viewedChildSessionIds.has(m.session.id),
        latestUserMsgId: m.session.latestUserMsgId,
        quietForMs,
      };
    });

    return {
      workItemId: wid,
      taskNumber: row.taskNumber,
      title: doc?.title?.trim() || row.workItemTitle?.trim() || row.session?.title?.trim() || wid,
      mode: doc?.mode ?? row.collaborationMode ?? 'delegated',
      bucket: row.bucket,
      memberCount: members.length,
      members,
      pullRequests: prs,
      externalRefs: doc?.externalRefs ?? row.externalRefs ?? [],
    };
  });

  const cursorBySessionId = new Map<string, CoordinatorDiagnosticsCursorEntry>();
  for (const c of args.diagnostics?.cursors ?? []) {
    cursorBySessionId.set(c.targetSessionId, c);
  }

  const cursorAudits: CoordinatorObservabilityCursorAudit[] = [];
  for (const wi of workItems) {
    for (const member of wi.members) {
      const storedCursor = cursorBySessionId.get(member.sessionId);
      const ownerRow = sessionRowById.get(member.sessionId);
      const memberPrs =
        ownerRow?.members?.find((m) => m.session.id === member.sessionId)?.pullRequests ??
        (ownerRow?.session?.id === member.sessionId ? wi.pullRequests : []);
      const livePrSig = buildPrDigestSignature(memberPrs);

      let status: CoordinatorObservabilityCursorStatus = 'synced';
      if (!storedCursor) {
        status = args.diagnostics ? 'unseeded' : 'synced';
      } else if (
        member.latestUserMsgId &&
        member.latestUserMsgId !== (storedCursor.latestUserMsgId ?? null)
      ) {
        status = 'pending_turn_delta';
      } else if (livePrSig !== storedCursor.prSignature) {
        status = 'pending_pr_delta';
      }

      cursorAudits.push({
        sessionId: member.sessionId,
        sessionTitle: member.title,
        workItemId: wi.workItemId,
        taskNumber: wi.taskNumber,
        role: member.role,
        mode: wi.mode,
        cursorTurnId: storedCursor?.latestUserMsgId ?? null,
        liveTurnId: member.latestUserMsgId ?? null,
        cursorUpdatedAt: storedCursor?.updatedAt ?? null,
        liveLastMessageAt:
          ownerRow?.members?.find((m) => m.session.id === member.sessionId)?.latestMessageAt ??
          ownerRow?.latestMessageAt ??
          0,
        prCount: memberPrs.length,
        status,
      });
    }
  }

  const cards: CoordinatorObservabilityCardAudit[] = [];
  const events: CoordinatorTraceEvent[] = [];

  args.history.forEach((turn, turnIndex) => {
    const baseTs = toEpochMs(turn.timestamp, nowMs - (args.history.length - turnIndex) * 1000);

    if (turn.role === 'user') {
      const text = extractUserMessageText(turn);
      const cfg = normalizeSessionTurnInputConfig(turn.inputConfig);
      const replyTo = cfg?.replyTo;
      const linked = extractLinkedSessionIdsFromText(text);
      events.push({
        id: `evt:user:${turn.id}`,
        timestampMs: baseTs,
        kind: 'user_turn',
        layer: 'coordinator',
        severity: 'normal',
        badge: replyTo ? 'REPLY' : 'USER',
        title: replyTo ? `User replied in thread` : `User sent instruction`,
        summary: truncateText(text || '(attachment / structured input)', 140),
        detailPayload: safePrettyJson({
          turnId: turn.id,
          replyTo: replyTo ?? null,
          prompt: text,
        }),
        turnId: turn.id,
        linkedSessionIds: linked,
        activeNodes: ['human', 'store', 'reconciler'],
        activeEdges: ['human_to_store', 'gate_to_coord'],
      });
      return;
    }

    if (turn.role === 'system') {
      (turn.items ?? []).forEach((item, itemIdx) => {
        if (item.type === 'operation_completion_batch') {
          const targetIds: string[] = [];
          for (const member of item.members ?? []) {
            for (const res of member.completion.type === 'result'
              ? member.completion.value.items
              : []) {
              if (res.target?.sessionId && !targetIds.includes(res.target.sessionId)) {
                targetIds.push(res.target.sessionId);
              }
            }
          }
          const primaryRow = targetIds[0] ? sessionRowById.get(targetIds[0]) : undefined;
          events.push({
            id: `evt:inbox-batch:${turn.id}:${itemIdx}`,
            timestampMs: baseTs + itemIdx,
            kind: 'operation_inbox',
            layer: 'squads',
            severity: 'highlight',
            badge: 'INBOX',
            title: `Session Inbox delivered ${item.memberCount} operation result(s)`,
            summary:
              targetIds.length > 0
                ? `Completed child sessions: ${targetIds.map((id) => sessionTitleById.get(id) ?? id).join(', ')}`
                : `Batch ${item.batchId}`,
            detailPayload: safePrettyJson({
              batchId: item.batchId,
              memberCount: item.memberCount,
              deliveryStatus: item.deliveryStatus,
              targetSessionIds: targetIds,
            }),
            turnId: turn.id,
            workItemId: primaryRow?.workItemId,
            taskNumber: primaryRow?.taskNumber,
            linkedSessionIds: targetIds,
            activeNodes: ['workers', 'store', 'reconciler'],
            activeEdges: ['workers_to_store', 'store_to_gate', 'gate_to_coord'],
          });
        } else if (item.type === 'operation_progress') {
          const targetIds = item.items.map((entry) => entry.target.sessionId);
          const primaryRow = targetIds[0] ? sessionRowById.get(targetIds[0]) : undefined;
          events.push({
            id: `evt:op-progress:${turn.id}:${itemIdx}`,
            timestampMs: baseTs + itemIdx,
            kind: 'operation_inbox',
            layer: 'squads',
            severity: 'normal',
            badge: 'OP',
            title: `Operation ${item.operationKind} (${item.items.length} target)`,
            summary: targetIds.map((id) => sessionTitleById.get(id) ?? id).join(', '),
            detailPayload: safePrettyJson({
              operationId: item.operationId,
              operationKind: item.operationKind,
              targets: item.items,
            }),
            turnId: turn.id,
            workItemId: primaryRow?.workItemId,
            taskNumber: primaryRow?.taskNumber,
            linkedSessionIds: targetIds,
            activeNodes: ['reconciler', 'store', 'workers'],
            activeEdges: ['coord_to_store', 'store_to_workers'],
          });
        }
      });
      return;
    }

    if (turn.role === 'assistant') {
      (turn.items ?? []).forEach((item, itemIdx) => {
        const stepTs = baseTs + itemIdx;
        if (item.type === 'tool_call') {
          const toolName = inferToolName(item);
          const rawInput = collectToolInputPayload(item);
          const serialized = safePrettyJson(rawInput) ?? '';
          const linked = extractLinkedSessionIdsFromText(serialized);

          if (
            toolName.includes('session_create') ||
            toolName.includes('session_chat') ||
            toolName.includes('session_cancel')
          ) {
            const primaryRow = linked[0] ? sessionRowById.get(linked[0]) : undefined;
            events.push({
              id: `evt:tool-dispatch:${turn.id}:${item.toolCallId}`,
              timestampMs: stepTs,
              kind: 'dispatch_tool',
              layer: 'squads',
              severity: item.status === 'failed' ? 'error' : 'highlight',
              badge: toolName.replace(/^mcp_[a-z]+_|^lody_/iu, '').toUpperCase(),
              title: `Coordinator invoked ${toolName}`,
              summary:
                linked.length > 0
                  ? `Target: ${linked.map((id) => sessionTitleById.get(id) ?? id).join(', ')}`
                  : truncateText(item.title || toolName, 120),
              detailPayload: serialized || safePrettyJson(item),
              turnId: turn.id,
              workItemId: primaryRow?.workItemId,
              taskNumber: primaryRow?.taskNumber,
              linkedSessionIds: linked,
              activeNodes: ['reconciler', 'store', 'workers'],
              activeEdges: ['coord_to_store', 'store_to_workers'],
            });
          } else if (toolName.includes('coordinator_work_item')) {
            const rec =
              rawInput && typeof rawInput === 'object'
                ? (rawInput as Record<string, unknown>)
                : undefined;
            const modeLabel = typeof rec?.mode === 'string' ? `mode=${rec.mode}` : 'group';
            const titleLabel = typeof rec?.title === 'string' ? rec.title : '';
            events.push({
              id: `evt:tool-wi:${turn.id}:${item.toolCallId}`,
              timestampMs: stepTs,
              kind: 'work_item_tool',
              layer: 'squads',
              severity: 'highlight',
              badge: 'WORK_ITEM',
              title: `Upserted WorkItem (${modeLabel})`,
              summary: truncateText(titleLabel || serialized || 'Updated WorkItem blackboard', 140),
              detailPayload: serialized || safePrettyJson(item),
              turnId: turn.id,
              linkedSessionIds: linked,
              activeNodes: ['reconciler', 'store', 'human'],
              activeEdges: ['coord_to_store', 'store_to_ui'],
            });
          } else if (toolName.includes('automation')) {
            events.push({
              id: `evt:tool-auto:${turn.id}:${item.toolCallId}`,
              timestampMs: stepTs,
              kind: 'automation_tool',
              layer: 'wake_gate',
              severity: 'highlight',
              badge: 'WATCH',
              title: `Coordinator configured CodeMode watch (${toolName})`,
              summary: truncateText(serialized || item.title || 'Automation registration', 140),
              detailPayload: serialized || safePrettyJson(item),
              turnId: turn.id,
              linkedSessionIds: linked,
              activeNodes: ['reconciler', 'store'],
              activeEdges: ['coord_to_store', 'store_to_gate'],
            });
          }
          return;
        }

        if (item.type === 'coordinator_message') {
          const msgTs = typeof item.createdAt === 'number' ? item.createdAt : stepTs;
          const normalizedCard = normalizeCoordinatorProactiveCard(item.card);
          const legacyActions = normalizedCard ? [] : normalizeCoordinatorActionSpecs(item.actions);
          const hasCard = Boolean(normalizedCard || legacyActions.length > 0);
          const linkedSet = new Set<string>([
            ...(item.linkedSessionIds ?? []),
            ...extractLinkedSessionIdsFromText(item.body),
            ...(normalizedCard?.workItemId ? [normalizedCard.workItemId] : []),
            ...extractActionLinkedSessionIds(normalizedCard?.actions ?? legacyActions),
          ]);
          const linked = [...linkedSet];
          const primaryRow = linked[0]
            ? (sessionRowById.get(linked[0]) ?? args.tasksById.get(linked[0]))
            : undefined;

          if (!hasCard && item.body.trim()) {
            events.push({
              id: `evt:bubble:${turn.id}:${item.id}`,
              timestampMs: msgTs,
              kind: 'coordinator_bubble',
              layer: 'coordinator',
              severity: 'normal',
              badge: 'BUBBLE',
              title: `Coordinator message`,
              summary: truncateText(item.body, 140),
              detailPayload: safePrettyJson({
                bubbleId: item.id,
                replyTo: item.replyTo ?? null,
                linkedSessionIds: linked,
                body: item.body,
              }),
              turnId: turn.id,
              workItemId: primaryRow?.workItemId,
              taskNumber: primaryRow?.taskNumber,
              linkedSessionIds: linked,
              activeNodes: ['reconciler', 'human'],
              activeEdges: ['coord_to_store', 'store_to_ui'],
            });
            return;
          }

          if (hasCard) {
            const bubbleKey = formatCoordinatorBubbleKey(turn.id, item.id);
            const resolutions = normalizeCoordinatorActionResolutions(item.actionResolutions);
            const actions = normalizedCard ? normalizedCard.actions : legacyActions;
            const snapshotChecks: CoordinatorObservabilityCardSnapshotCheck[] = Object.entries(
              normalizedCard?.snapshotTurnBySession ?? {}
            ).map(([sid, frozenTurnId]) => {
              const currentTurnId = sessionCurrentTurnById.get(sid) ?? null;
              return {
                sessionId: sid,
                sessionTitle: sessionTitleById.get(sid) ?? sid,
                frozenTurnId,
                currentTurnId,
                diverged: Boolean(currentTurnId && currentTurnId !== frozenTurnId),
              };
            });

            const chosenSpec = actions.find((a) => resolutions[a.id]?.status === 'executed');
            const customFeedback = resolutions[COORDINATOR_CUSTOM_FEEDBACK_ACTION_ID];
            const isDismissed =
              resolutions[COORDINATOR_CARD_DISMISSED_ACTION_ID]?.status === 'dismissed';
            const isAlreadyChosen = Boolean(
              isDismissed || chosenSpec || customFeedback?.status === 'executed'
            );

            const staleByChild =
              !isAlreadyChosen &&
              (snapshotChecks.some((chk) => chk.diverged) ||
                isCoordinatorCardStaleFromChildActivity({
                  snapshotTurnBySession: normalizedCard?.snapshotTurnBySession,
                  cardCreatedAt: item.createdAt,
                  linkedSessions: linked.map((sid) => ({
                    id: sid,
                    latestUserMsgId: sessionCurrentTurnById.get(sid),
                    latestMessageAt: sessionRowById.get(sid)?.latestMessageAt,
                  })),
                  isAlreadyChosen: false,
                }));

            const verdict: CoordinatorObservabilityCardVerdict = isDismissed
              ? 'dismissed'
              : chosenSpec || customFeedback?.status === 'executed'
                ? 'chosen'
                : staleByChild
                  ? 'superseded_by_child'
                  : args.supersededCardKeys?.has(bubbleKey)
                    ? 'superseded_by_stream'
                    : 'open';

            const cardKind: CoordinatorCardKind = normalizedCard?.kind ?? 'next_step';
            const cardTitle = normalizedCard?.title ?? truncateText(item.body || 'Action card', 80);

            cards.push({
              key: bubbleKey,
              turnId: turn.id,
              bubbleId: item.id,
              createdAtMs: msgTs,
              kind: cardKind,
              title: cardTitle,
              summary: normalizedCard?.summary,
              workItemId: normalizedCard?.workItemId ?? primaryRow?.workItemId,
              taskNumber: primaryRow?.taskNumber ?? null,
              verdict,
              chosenLabel:
                chosenSpec?.label ??
                (customFeedback?.status === 'executed' ? customFeedback.summary : undefined),
              actionCount: actions.length,
              snapshotChecks,
            });

            events.push({
              id: `evt:card:${turn.id}:${item.id}`,
              timestampMs: msgTs,
              kind: 'proactive_card',
              layer: 'cards',
              severity: cardKind === 'handoff' ? 'highlight' : 'normal',
              badge: `CARD:${cardKind.toUpperCase()}`,
              title: cardTitle,
              summary: `Verdict: ${verdict} · ${actions.length} option(s)${
                snapshotChecks.length > 0 ? ` · ${snapshotChecks.length} causal anchor(s)` : ''
              }`,
              detailPayload: safePrettyJson({
                kind: cardKind,
                verdict,
                workItemId: normalizedCard?.workItemId ?? primaryRow?.workItemId ?? null,
                snapshotTurnBySession: normalizedCard?.snapshotTurnBySession ?? {},
                actions: actions.map((a) => ({ id: a.id, label: a.label, intent: a.intent })),
                resolutions,
              }),
              turnId: turn.id,
              workItemId: primaryRow?.workItemId,
              taskNumber: primaryRow?.taskNumber,
              linkedSessionIds: linked,
              activeNodes:
                cardKind === 'handoff'
                  ? ['reconciler', 'store', 'human', 'workers']
                  : ['reconciler', 'store', 'human'],
              activeEdges:
                cardKind === 'handoff'
                  ? ['coord_to_store', 'store_to_ui', 'human_to_store']
                  : ['coord_to_store', 'store_to_ui'],
            });

            if (verdict === 'superseded_by_child') {
              const divergedList = snapshotChecks.filter((c) => c.diverged);
              const newestChildTs = Math.max(
                msgTs + 1,
                ...linked.map((sid) => sessionRowById.get(sid)?.latestMessageAt ?? 0)
              );
              events.push({
                id: `evt:card-stale:${turn.id}:${item.id}`,
                timestampMs: newestChildTs,
                kind: 'card_superseded',
                layer: 'cards',
                severity: 'warning',
                badge: 'CAUSAL_INVALIDATION',
                title: `Card auto-collapsed by direct child progress`,
                summary:
                  divergedList.length > 0
                    ? divergedList
                        .map(
                          (d) =>
                            `${d.sessionTitle}: frozen ${d.frozenTurnId.slice(0, 8)} ≠ live ${(d.currentTurnId ?? '').slice(0, 8)}`
                        )
                        .join('; ')
                    : `Card "${cardTitle}" overtaken by child activity`,
                detailPayload: safePrettyJson({
                  cardTitle,
                  divergedAnchors: divergedList,
                }),
                turnId: turn.id,
                workItemId: primaryRow?.workItemId,
                taskNumber: primaryRow?.taskNumber,
                linkedSessionIds: linked,
                activeNodes: ['workers', 'store', 'human'],
                activeEdges: ['workers_to_store', 'store_to_ui'],
              });
            }
          }
        }
      });
    }
  });

  if (args.diagnostics?.lastTurnDelta && args.diagnostics.lastTurnDelta.deltaText.trim()) {
    const delta = args.diagnostics.lastTurnDelta;
    events.push({
      id: `evt:delta:${delta.userTurnId}`,
      timestampMs: delta.updatedAt,
      kind: 'cursor_delta_injected',
      layer: 'cursor',
      severity: 'highlight',
      badge: 'FACTS_DELTA',
      title: `Injected <project_facts_delta> into turn ${delta.userTurnId.slice(0, 10)}`,
      summary: truncateText(delta.deltaText.replace(/<[^>]+>/gu, ' '), 150),
      detailPayload: delta.deltaText,
      turnId: delta.userTurnId,
      linkedSessionIds: extractLinkedSessionIdsFromText(delta.deltaText),
      activeNodes: ['store', 'reconciler'],
      activeEdges: ['store_to_gate', 'gate_to_coord'],
    });
  }

  for (const audit of cursorAudits) {
    if (audit.status === 'pending_turn_delta' || audit.status === 'pending_pr_delta') {
      events.push({
        id: `evt:cursor-lag:${audit.sessionId}`,
        timestampMs: Math.max(audit.liveLastMessageAt, audit.cursorUpdatedAt ?? 0, 1),
        kind: 'cursor_lag_pending',
        layer: 'cursor',
        severity: 'warning',
        badge: 'CURSOR_LAG',
        title: `Unseen ${audit.status === 'pending_turn_delta' ? 'direct turn' : 'PR state'} queued for lazy <project_facts_delta>`,
        summary: `${audit.sessionTitle}: SQLite cursor=${audit.cursorTurnId?.slice(0, 8) ?? 'none'} → live=${audit.liveTurnId?.slice(0, 8) ?? 'none'}`,
        detailPayload: safePrettyJson(audit),
        workItemId: audit.workItemId,
        taskNumber: audit.taskNumber,
        linkedSessionIds: [audit.sessionId],
        activeNodes: ['workers', 'store'],
        activeEdges: ['workers_to_store'],
      });
    }
  }

  for (const wi of workItems) {
    for (const pr of wi.pullRequests) {
      const prLabel =
        pr.repoFullName && pr.number !== null ? `${pr.repoFullName}#${pr.number}` : pr.url;
      const ciState =
        pr.state?.s === 'f' || pr.state?.s === 'e'
          ? 'CI failing'
          : pr.readiness === 'y'
            ? 'Ready to merge'
            : pr.status;
      events.push({
        id: `evt:pr:${wi.workItemId}:${pr.url}`,
        timestampMs: pr.state?.t ? pr.state.t * 1000 : nowMs - 5000,
        kind: 'external_pr_signal',
        layer: 'wake_gate',
        severity: pr.state?.s === 'f' || pr.state?.s === 'e' ? 'warning' : 'normal',
        badge: `PR:${pr.status.toUpperCase()}`,
        title: `${prLabel} (${ciState})`,
        summary: `WorkItem ${wi.taskNumber !== null ? `T${wi.taskNumber}` : wi.workItemId} · ${wi.title}`,
        detailPayload: safePrettyJson(pr),
        workItemId: wi.workItemId,
        taskNumber: wi.taskNumber,
        linkedSessionIds: wi.members.map((m) => m.sessionId),
        activeNodes: ['connectors', 'store', 'human'],
        activeEdges: ['connectors_to_store', 'store_to_ui'],
      });
    }
  }

  const rawWaits: readonly CoordinatorDiagnosticsWaitEntry[] =
    args.diagnostics?.waits ??
    (args.fallbackWaits ?? []).map((w) => ({
      id: w.id,
      reason: w.reason,
      state: w.state,
      checks: 0,
      consecutiveErrors: 0,
      nextCheckAt: w.nextCheckAt,
      expiresAt: w.expiresAt,
      continuation: w.continuation,
    }));

  const remainingDebounceMs =
    shortestChildQuietMs !== null && shortestChildQuietMs < OBSERVABILITY_DEBOUNCE_WINDOW_MS
      ? Math.max(0, OBSERVABILITY_DEBOUNCE_WINDOW_MS - shortestChildQuietMs)
      : 0;

  const watches: CoordinatorObservabilityWatchAudit[] = rawWaits.map((w) => {
    const readsCoord =
      Boolean(w.reads?.includes('coordinator.workItems')) ||
      Boolean(w.program?.includes('coordinator.workItems'));
    const viewingIds = [...viewedChildSessionIds];
    let gateVerdict: CoordinatorObservabilityGateVerdict = 'inactive';
    if (w.state === 'failed') {
      gateVerdict = 'failed';
    } else if (w.state === 'matched') {
      gateVerdict = 'matched';
    } else if (w.state === 'waiting' || w.state === 'checking') {
      if (readsCoord && viewingIds.length > 0) {
        gateVerdict = 'suppressed_focus';
      } else if (readsCoord && remainingDebounceMs > 0) {
        gateVerdict = 'suppressed_debounce';
      } else if (readsCoord) {
        gateVerdict = 'pass_ready';
      } else {
        gateVerdict = 'waiting_condition';
      }
    }

    return {
      id: w.id,
      reason: w.reason?.trim() || 'CodeMode condition watch',
      program: w.program,
      state: w.state,
      checks: w.checks,
      consecutiveErrors: w.consecutiveErrors,
      lastError: w.lastError,
      nextCheckAt: w.nextCheckAt,
      nextCheckInMs: Math.max(0, w.nextCheckAt - nowMs),
      readsCoordinatorWorkItems: readsCoord,
      gateVerdict,
      viewingSessionIds: viewingIds,
      remainingDebounceMs,
      continuationState: w.continuation?.state,
      continuationReason: w.continuation?.reason,
    };
  });

  for (const watch of watches) {
    if (
      watch.state === 'waiting' ||
      watch.state === 'checking' ||
      watch.state === 'matched' ||
      watch.state === 'failed'
    ) {
      events.push({
        id: `evt:watch:${watch.id}`,
        timestampMs: watch.state === 'matched' ? nowMs - 1000 : nowMs,
        kind: 'watch_gate_status',
        layer: 'wake_gate',
        severity:
          watch.gateVerdict === 'failed'
            ? 'error'
            : watch.gateVerdict === 'suppressed_focus' ||
                watch.gateVerdict === 'suppressed_debounce'
              ? 'warning'
              : 'highlight',
        badge: `GATE:${watch.gateVerdict.toUpperCase()}`,
        title: watch.reason,
        summary: `State: ${watch.state} · Checks: ${watch.checks} · Gate: ${watch.gateVerdict}`,
        detailPayload: safePrettyJson(watch),
        linkedSessionIds: watch.viewingSessionIds,
        activeNodes:
          watch.gateVerdict === 'matched'
            ? ['store', 'reconciler']
            : [
                'store',
                'reconciler',
                ...(watch.viewingSessionIds.length > 0 ? (['human'] as const) : []),
              ],
        activeEdges:
          watch.gateVerdict === 'matched' ? ['store_to_gate', 'gate_to_coord'] : ['store_to_gate'],
      });
    }
  }

  events.sort((a, b) => b.timestampMs - a.timestampMs || a.id.localeCompare(b.id));

  const liveActiveNodes = new Set<ObservabilityTopologyNodeId>(['store']);
  const liveActiveEdges = new Set<ObservabilityTopologyEdgeId>(['store_to_ui']);

  if (viewedChildSessionIds.size > 0) {
    liveActiveNodes.add('human');
    liveActiveNodes.add('workers');
    liveActiveEdges.add('human_to_store');
  }
  if (activeWorkerCount > 0) {
    liveActiveNodes.add('workers');
    liveActiveEdges.add('workers_to_store');
    liveActiveEdges.add('store_to_workers');
  }
  if (pullRequestCount > 0) {
    liveActiveNodes.add('connectors');
    liveActiveEdges.add('connectors_to_store');
  }
  const activeWatchCount = watches.filter(
    (w) => w.state === 'waiting' || w.state === 'checking'
  ).length;
  const suppressedWatchCount = watches.filter(
    (w) => w.gateVerdict === 'suppressed_focus' || w.gateVerdict === 'suppressed_debounce'
  ).length;
  if (activeWatchCount > 0) {
    liveActiveNodes.add('reconciler');
    liveActiveEdges.add('store_to_gate');
    if (suppressedWatchCount === 0) {
      liveActiveEdges.add('gate_to_coord');
    }
  }
  if (events[0]) {
    for (const n of events[0].activeNodes) liveActiveNodes.add(n);
    for (const e of events[0].activeEdges) liveActiveEdges.add(e);
  }

  return {
    nowMs,
    diagnosticsConnected: Boolean(args.diagnostics),
    metrics: {
      workItemCount: workItems.length,
      directWorkItemCount: workItems.filter((w) => w.mode === 'direct').length,
      memberSessionCount: workItems.reduce((acc, w) => acc + w.memberCount, 0),
      activeWorkerCount,
      pullRequestCount,
      openCardCount: cards.filter((c) => c.verdict === 'open').length,
      supersededCardCount: cards.filter(
        (c) => c.verdict === 'superseded_by_child' || c.verdict === 'superseded_by_stream'
      ).length,
      pendingDeltaCount: cursorAudits.filter(
        (c) => c.status === 'pending_turn_delta' || c.status === 'pending_pr_delta'
      ).length,
      activeWatchCount,
      suppressedWatchCount,
    },
    liveActiveNodes,
    liveActiveEdges,
    viewedChildSessionIds,
    workItems,
    cards: [...cards].reverse(),
    cursorAudits,
    lastTurnDelta: args.diagnostics?.lastTurnDelta,
    operations: args.diagnostics?.operations ?? [],
    watches,
    events,
  };
}

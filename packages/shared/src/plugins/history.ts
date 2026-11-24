import type { MessageContent } from '../ai';
import type { SessionHistoryReader } from '../session-data/types';
import { isAskUserQuestionPermissionMeta } from '../acp/ask-user-question';
export function toolFact(item: Extract<MessageContent, { type: 'tool_call' }>) {
  const kind = item.kind;
  return {
    toolCallId: item.toolCallId,
    toolName: (item.toolName ?? item.title ?? '').slice(0, 256),
    title: (item.title ?? '').slice(0, 256),
    status: item.status === 'completed' || item.status === 'failed' ? item.status : 'running',
    acpKind:
      kind === 'bash'
        ? 'execute'
        : kind === 'write'
          ? 'edit'
          : kind === 'computer' || kind === 'mcp'
            ? 'other'
            : (kind ?? 'other'),
    locations: (item.locations ?? [])
      .slice(0, 8)
      .map((l) => ({ path: l.path.slice(0, 512), line: l.line ?? undefined })),
  } as const;
}
function runSummary(task: Extract<MessageContent, { type: 'subagent_task' }>) {
  const state = task.run?.snapshot.state ?? task.status;
  return {
    runId: task.taskId,
    title: task.run?.snapshot.name ?? task.description ?? task.taskId,
    status: state === 'pending' || state === 'in_progress' ? 'running' : state,
    latestStepPreview: task.run?.progress?.summary ?? task.summary,
  } as const;
}
export async function readPluginSubagentRun(
  reader: SessionHistoryReader,
  runId: string,
  check: () => void
) {
  for (let end = await reader.count(); end > 0; end -= 32) {
    const dir = await reader.readDirectory(Math.max(0, end - 32), end);
    for (let i = dir.length - 1; i >= 0; i--) {
      const row = dir[i]!;
      check();
      if (!row.turnId || row.scalars?.role !== 'assistant') continue;
      const read = reader.readTurnForDisplay
        ? await reader.readTurnForDisplay(row.turnId)
        : await reader.readTurn(row.turnId);
      if (read.state !== 'ready') continue;
      const turn = read.turn;
      for (const task of (turn.items ?? []) as readonly MessageContent[]) {
        if (task.type !== 'subagent_task' || task.taskId !== runId) continue;
        const summary = runSummary(task);
        const run =
          task.run && reader.readSubagentRun
            ? await reader.readSubagentRun(turn.id, task.run.sessionId, runId)
            : task.run;
        check();
        if (!run) return { ...summary, turns: [] };
        const records = new Map<
          string,
          {
            turnId: string;
            role: 'assistant';
            createdAt: number;
            finished: boolean;
            proseMarkdown: string;
            previewText: string;
            thoughtMarkdown: string;
            toolCalls: ReturnType<typeof toolFact>[];
            subagentRuns: never[];
          }
        >();
        for (const item of run.items) {
          const turnId = item.nativeTurnId ?? item.messageId ?? task.taskId;
          const prior = records.get(turnId);
          const prose = (prior?.proseMarkdown ?? '') + (item.type === 'text' ? item.text : '');
          records.set(turnId, {
            turnId,
            role: 'assistant',
            createdAt:
              (run.snapshot.startedAtEpochSeconds ?? Date.parse(turn.timestamp) / 1000) * 1000,
            finished: summary.status !== 'running',
            proseMarkdown: prose,
            previewText: prose.slice(0, 256),
            thoughtMarkdown:
              (prior?.thoughtMarkdown ?? '') + (item.type === 'thought' ? item.text : ''),
            toolCalls:
              item.type === 'tool_call'
                ? [...(prior?.toolCalls ?? []), toolFact(item)]
                : (prior?.toolCalls ?? []),
            subagentRuns: [],
          });
        }
        return { ...summary, turns: [...records.values()] };
      }
    }
  }
  return null;
}
export async function readPluginTurnPage(
  reader: SessionHistoryReader,
  limit: number,
  offset: number,
  check: () => void
) {
  const end = Math.max(0, (await reader.count()) - offset),
    start = Math.max(0, end - Math.max(1, limit));
  const rows = await reader.readRange(start, end);
  check();
  let pendingInteraction:
    | {
        requestId: string;
        turnId: string;
        kind: 'elicitation' | 'permission';
        title?: string;
        options: Array<{ optionId: string; name: string; kind?: string }>;
      }
    | undefined;
  const items = rows.flatMap((row) => {
    const turn = row.state === 'ready' ? row.turn : undefined;
    if (!turn || (turn.role !== 'assistant' && turn.role !== 'user')) return [];
    const content = (turn.items ?? []) as readonly MessageContent[];
    const proseMarkdown = content.flatMap((x) => (x.type === 'text' ? [x.text] : [])).join('\n');
    const tools = content.flatMap((x) => (x.type === 'tool_call' ? [x] : []));
    const finished = turn.role === 'user' || !!turn.finished || turn.endedAt != null;
    for (const tool of tools) {
      const req = tool.permissionRequest;
      if (!finished && req && !req.outcome)
        pendingInteraction = {
          requestId: req.requestId,
          turnId: turn.id,
          kind: isAskUserQuestionPermissionMeta(req._meta) ? 'elicitation' : 'permission',
          title: tool.title ?? undefined,
          options: req.options.map((o) => ({
            optionId: o.optionId,
            name: o.name,
            kind: o.kind ?? undefined,
          })),
        };
    }
    return [
      {
        turnId: turn.id,
        role: turn.role,
        userTurnId: turn.userTurnId,
        previewText: proseMarkdown.slice(0, 256),
        createdAt: Date.parse(turn.timestamp),
        finished,
        proseMarkdown,
        thoughtMarkdown:
          content.flatMap((x) => (x.type === 'thought' ? [x.text] : [])).join('\n') || undefined,
        toolCalls: tools.map(toolFact),
        endedAt: turn.endedAt ?? undefined,
        stopReason:
          finished && turn.role === 'assistant'
            ? turn.status === 'canceled'
              ? 'cancelled'
              : turn.status === 'failed'
                ? 'error'
                : 'end_turn'
            : undefined,
        planMarkdown: content
          .flatMap((x) => (x.type === 'proposed_plan' ? [x.markdown] : []))
          .at(-1),
        subagentRuns: content.flatMap((x) => (x.type === 'subagent_task' ? [runSummary(x)] : [])),
      } as const,
    ];
  });
  return {
    items: limit ? items : [],
    pendingInteraction,
    ...(start > 0 ? { nextCursor: String(offset + end - start) } : {}),
  };
}

export function sessionSummaryFacts<P>(
  s: import('../schema').SessionMeta,
  account: string | null,
  online: boolean,
  project: P
) {
  const createdAt = Date.parse(s.createdAt);
  return {
    title: s.title ?? '',
    status: s.collaborationStopped
      ? 'stopped'
      : s.status?.type === 'requestPermission'
        ? 'waiting'
        : s.status?.type === 'running' || s.status?.type === 'initializing'
          ? 'busy'
          : 'idle',
    machinePresence: online ? 'online' : 'offline',
    isMine: s.userId === account,
    userId: s.userId,
    archived: !!s.isArchived,
    createdByPluginId: s.createdByPluginId,
    businessKey: s.businessKey,
    createdAt,
    updatedAt: Math.max(createdAt, s.lastMessageAt ?? 0, s.lastRunningSeen ?? 0),
    openedByRootSessionId: s.openedByRootSessionId,
    openedBySessionId: s.openedBySessionId ?? s.parentSessionId,
    agentRoleId: s.agentRoleId,
    agentRoleRevision: s.agentRoleRevision,
    cliType: s.cliType,
    lastModel: s.lastModel,
    contextWindowUsage: s.contextWindowUsage
      ? { usedTokens: s.contextWindowUsage.used, maxTokens: s.contextWindowUsage.size }
      : undefined,
    branchName: s.branchName,
    baseBranch: s.baseBranch,
    isWorktree: s.isWorktree,
    isPinned: s.isPinned,
    pinSectionId: s.pinSectionId,
    orderKey: s.orderKey,
    snoozedUntil: s.snoozedUntil,
    settledAt: s.settledAt,
    scheduleId: s.scheduleId,
    pullRequests: (s.pullRequests ?? []).map((p) => ({
      url: p.url,
      state: p.status === 'draft' ? 'open' : p.status,
      draft: p.status === 'draft',
      project,
    })),
  } as const;
}

export function filterPluginSessions<
  S extends {
    session: { sessionId: string; machineId: string };
    project?: { projectId: string };
    archived: boolean;
    status: string;
    agentRoleId?: string;
    isMine: boolean;
    createdByPluginId?: string;
    businessKey?: string;
    openedByRootSessionId?: string;
    openedBySessionId?: string;
    updatedAt: number;
    title: string;
  },
>(
  rows: readonly S[],
  target: { workspaceId: string; machineId?: string; projectId?: string },
  pluginId: string,
  f: {
    machineId?: string;
    sessionIds?: readonly string[];
    archived?: boolean;
    status?: string;
    agentRoleId?: string;
    createdByMe?: boolean;
    createdByPlugin?: boolean;
    businessKey?: string;
    rootSessionId?: string;
    updatedAfter?: number;
    search?: string;
    cursor?: string;
    limit?: number;
  }
) {
  const filtered = rows
    .filter(
      (s) =>
        (!target.machineId || s.session.machineId === target.machineId) &&
        (!target.projectId || s.project?.projectId === target.projectId) &&
        (!f.machineId || s.session.machineId === f.machineId) &&
        (!f.sessionIds || f.sessionIds.includes(s.session.sessionId)) &&
        (f.archived === undefined || s.archived === f.archived) &&
        (!f.status || s.status === f.status) &&
        (!f.agentRoleId || s.agentRoleId === f.agentRoleId) &&
        (!f.createdByMe || s.isMine) &&
        (!f.createdByPlugin || s.createdByPluginId === pluginId) &&
        (!f.businessKey || (s.createdByPluginId === pluginId && s.businessKey === f.businessKey)) &&
        (!f.rootSessionId ||
          s.session.sessionId === f.rootSessionId ||
          (s.openedByRootSessionId ?? s.openedBySessionId) === f.rootSessionId) &&
        (f.updatedAfter === undefined || s.updatedAt >= f.updatedAfter) &&
        (!f.search || s.title.toLowerCase().includes(f.search.toLowerCase()))
    )
    .sort(
      (a, b) => b.updatedAt - a.updatedAt || a.session.sessionId.localeCompare(b.session.sessionId)
    );
  const start = Number(f.cursor ?? 0),
    limit = f.limit ?? 100;
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(limit) || limit < 1)
    throw Error('Invalid sessions page');
  const items = filtered.slice(start, start + limit).map((s) => {
    if (s.createdByPluginId === pluginId) return s;
    const { businessKey: _, ...visible } = s;
    return visible;
  });
  return structuredClone({
    items,
    ...(start + items.length < filtered.length ? { nextCursor: String(start + items.length) } : {}),
  });
}

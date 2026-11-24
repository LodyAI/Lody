import {
  deriveSessionPullRequestReadiness,
  normalizeCoordinatorWorkItemsMap,
  normalizeSessionTurnInputConfig,
  readMessageAuthor,
  type CoordinatorWorkItemDoc,
  type SessionId,
  type SessionMeta,
  type WorkspaceId,
} from '@lody/shared';
import type { SessionHistoryReader, SessionTurn } from '@lody/shared/session-data';
import type {
  CoordinatorCursorStorePort,
  CoordinatorReadCursorInput,
} from '@/orchestration/operation-store';

const MAX_DELTA_TAIL_READ_SESSIONS = 6;
const MAX_DELTA_CONCURRENT_READS = 4;
const MAX_TAIL_DIRECTORY_TURNS = 10;
const MAX_DIRECT_EXCHANGES_PER_SESSION = 2;
const MAX_EXCERPT_CHARS = 240;
const MAX_DELTA_BLOCK_CHARS = 4096;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function truncatePlainText(raw: string, maxChars: number): string {
  const normalized = raw.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function extractTurnPlainText(turn: SessionTurn): string {
  const parts: string[] = [];
  for (const item of turn.items ?? []) {
    if (!isRecord(item)) continue;
    if (item.type === 'text' && typeof item.text === 'string' && item.text.trim().length > 0) {
      parts.push(item.text.trim());
    }
  }
  if (parts.length > 0) return parts.join('\n');
  if (turn.role === 'user') {
    const config = normalizeSessionTurnInputConfig(turn.inputConfig);
    return config?.prompt?.trim() ?? '';
  }
  return '';
}

function parseGithubPullSlug(url: string): string {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length >= 4 && segments[2] === 'pull') {
      const num = Number(segments[3]);
      if (Number.isSafeInteger(num) && num > 0) {
        return `${segments[0]}/${segments[1]}#${num}`;
      }
    }
  } catch {
    return url;
  }
  return url;
}

function createdEpochMs(meta: Pick<SessionMeta, 'createdAt'>): number {
  if (!meta.createdAt) return 0;
  const parsed = Date.parse(meta.createdAt);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function latestActivityEpochMs(meta: SessionMeta): number {
  const msgAt =
    typeof meta.lastMessageAt === 'number' && Number.isFinite(meta.lastMessageAt)
      ? meta.lastMessageAt
      : 0;
  return Math.max(msgAt, createdEpochMs(meta));
}

function resolveWorkItemId(meta: SessionMeta): string {
  const explicit = meta.workItemId?.trim();
  return explicit && explicit.length > 0 ? explicit : meta.id;
}

function buildStatusSignature(
  meta: SessionMeta,
  workItemDoc: CoordinatorWorkItemDoc | undefined
): string {
  const latestAt = latestActivityEpochMs(meta);
  const accepted =
    Boolean(meta.isArchived) ||
    (typeof meta.coordinatorTaskAcceptedAt === 'number' &&
      meta.coordinatorTaskAcceptedAt >= latestAt);
  const awaiting = typeof meta.awaitingUserSince === 'number' && meta.awaitingUserSince > 0;
  const mode = workItemDoc?.mode ?? 'delegated';
  const role = meta.workItemRole?.trim() ?? '';
  return JSON.stringify({
    wi: resolveWorkItemId(meta),
    role,
    mode,
    accepted,
    archived: Boolean(meta.isArchived),
    awaiting,
  });
}

function buildPrSignature(meta: SessionMeta): string {
  const prs = meta.pullRequests ?? [];
  if (prs.length === 0) return '';
  const entries = prs
    .map((pr) => {
      const state = meta.pullRequestState?.[pr.url] ?? null;
      const readiness = pr.status === 'open' ? deriveSessionPullRequestReadiness(state) : null;
      return {
        url: pr.url.trim().toLowerCase(),
        status: pr.status,
        readiness: readiness ?? '',
        ci: state?.s ?? '',
        merge: state?.m ?? '',
      };
    })
    .sort((a, b) => a.url.localeCompare(b.url));
  return JSON.stringify(entries);
}

function formatPrSummaryList(meta: SessionMeta): string[] {
  const prs = meta.pullRequests ?? [];
  const out: string[] = [];
  for (const pr of prs) {
    const slug = parseGithubPullSlug(pr.url);
    const state = meta.pullRequestState?.[pr.url] ?? null;
    const details: string[] = [pr.status];
    if (state?.s === 's') details.push('ci:pass');
    else if (state?.s === 'f' || state?.s === 'e') details.push('ci:fail');
    else if (state?.s === 'p') details.push('ci:pending');
    if (state?.m === 'd') details.push('conflicts');
    else if (pr.status === 'open' && deriveSessionPullRequestReadiness(state) === 'y')
      details.push('ready-to-merge');
    out.push(`${slug} (${details.join(', ')})`);
  }
  return out;
}

export type DirectChildExchange = {
  readonly userText: string;
  readonly assistantText?: string;
};

export type ChildDirectTailSummary = {
  readonly directExchanges: readonly DirectChildExchange[];
  readonly hasNonCoordinatorUserTurn: boolean;
};

/**
 * Reads a bounded tail window of a child conversation's history to extract
 * user/assistant exchanges authored directly (not dispatched by `coordinatorSessionId`)
 * after `previousLatestUserMsgId`.
 */
export async function extractChildDirectTailSummary(args: {
  history: SessionHistoryReader;
  coordinatorSessionId: SessionId;
  previousLatestUserMsgId?: string;
}): Promise<ChildDirectTailSummary> {
  const total = await args.history.count();
  if (total <= 0) {
    return { directExchanges: [], hasNonCoordinatorUserTurn: false };
  }
  const windowSize = Math.min(total, MAX_TAIL_DIRECTORY_TURNS);
  const start = Math.max(0, total - windowSize);
  const directory = await args.history.readDirectory(start, windowSize);

  let startIdx = 0;
  if (args.previousLatestUserMsgId) {
    const prevIdx = directory.findIndex(
      (row) => (row?.turnId ?? row?.scalars?.id) === args.previousLatestUserMsgId
    );
    if (prevIdx >= 0) {
      startIdx = prevIdx + 1;
    }
  }

  const turns: SessionTurn[] = [];
  for (let i = startIdx; i < directory.length; i += 1) {
    const turnId = directory[i]?.turnId ?? directory[i]?.scalars?.id;
    if (!turnId) continue;
    const read = await args.history.readTurn(turnId);
    if (read.state === 'ready') {
      turns.push(read.turn);
    }
  }

  const exchanges: DirectChildExchange[] = [];
  let hasNonCoordinatorUserTurn = false;

  for (let i = 0; i < turns.length; i += 1) {
    const turn = turns[i]!;
    if (turn.role !== 'user') continue;
    const author = readMessageAuthor(turn.author);
    if (author?.kind === 'agent' && author.sessionId === args.coordinatorSessionId) {
      continue;
    }
    hasNonCoordinatorUserTurn = true;
    const userRaw = extractTurnPlainText(turn);
    if (!userRaw) continue;

    let assistantRaw = '';
    for (let j = i + 1; j < turns.length; j += 1) {
      const nextTurn = turns[j]!;
      if (nextTurn.role === 'user') break;
      if (nextTurn.role === 'assistant') {
        const text = extractTurnPlainText(nextTurn);
        if (text) assistantRaw = text;
      }
    }

    exchanges.push({
      userText: truncatePlainText(userRaw, MAX_EXCERPT_CHARS),
      ...(assistantRaw
        ? { assistantText: truncatePlainText(assistantRaw, MAX_EXCERPT_CHARS) }
        : {}),
    });
  }

  return {
    directExchanges: exchanges.slice(-MAX_DIRECT_EXCHANGES_PER_SESSION),
    hasNonCoordinatorUserTurn,
  };
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await worker(items[current]!);
    }
  });
  await Promise.all(runners);
  return results;
}

function buildCoordinatorWorkItemNumbers(
  childMetas: readonly SessionMeta[],
  workItems: Readonly<Record<string, CoordinatorWorkItemDoc>>
): Map<string, number> {
  const groups = new Map<string, number>();
  for (const meta of childMetas) {
    const wid = resolveWorkItemId(meta);
    const ts = createdEpochMs(meta);
    const prev = groups.get(wid);
    if (prev === undefined) {
      const docCreated = workItems[wid]?.createdAt;
      groups.set(
        wid,
        ts > 0 ? ts : typeof docCreated === 'number' && docCreated > 0 ? docCreated : 0
      );
    } else if (ts > 0 && (prev === 0 || ts < prev)) {
      groups.set(wid, ts);
    }
  }
  const ordered = [...groups.entries()].sort(
    ([idA, tsA], [idB, tsB]) => tsA - tsB || idA.localeCompare(idB)
  );
  const numbers = new Map<string, number>();
  ordered.forEach(([wid], index) => {
    const explicit = workItems[wid]?.taskNumber;
    numbers.set(
      wid,
      typeof explicit === 'number' && Number.isSafeInteger(explicit) && explicit > 0
        ? explicit
        : index + 1
    );
  });
  return numbers;
}

/**
 * Computes a bounded, factual `<project_facts_delta>` block from changes across
 * coordinator-managed child conversations since the coordinator's local SQLite
 * read cursor, and atomically advances the cursor for `userTurnId`.
 *
 * Re-evaluating the same `(coordinatorSessionId, userTurnId)` returns the cached
 * delta so turn startup retries never drop unseen facts.
 */
export async function resolveCoordinatorProjectFactsDelta(args: {
  workspaceId: WorkspaceId;
  coordinatorSessionId: SessionId;
  coordinatorUserId: string;
  userTurnId: string;
  allSessionMetas: readonly SessionMeta[];
  rawWorkItems?: unknown;
  cursorStore: CoordinatorCursorStorePort;
  readChildTail?: (
    sessionId: SessionId,
    previousLatestUserMsgId: string | undefined
  ) => Promise<ChildDirectTailSummary | undefined>;
}): Promise<string | undefined> {
  const cached = args.cursorStore.readCoordinatorTurnDelta(
    args.coordinatorSessionId,
    args.userTurnId
  );
  if (cached !== undefined) {
    return cached.length > 0 ? cached : undefined;
  }

  if (!args.coordinatorUserId) return undefined;
  const workItems = normalizeCoordinatorWorkItemsMap(args.rawWorkItems);

  const managedMetas = args.allSessionMetas.filter((meta) => {
    if (!meta || meta.id === args.coordinatorSessionId || meta.parentSessionId) return false;
    if (meta.userId !== args.coordinatorUserId) return false;
    if (meta.openedBySessionId === args.coordinatorSessionId) return true;
    const explicitWid = meta.workItemId?.trim();
    return Boolean(explicitWid && workItems[explicitWid]);
  });

  const priorCursors = args.cursorStore.readCoordinatorCursors(args.coordinatorSessionId);
  const aliveIds = new Set(managedMetas.map((m) => m.id));
  const removedTargetIds = [...priorCursors.keys()].filter((id) => !aliveIds.has(id as SessionId));

  if (managedMetas.length === 0) {
    args.cursorStore.commitCoordinatorTurnDelta({
      coordinatorSessionId: args.coordinatorSessionId,
      userTurnId: args.userTurnId,
      deltaText: '',
      cursors: [],
      removedTargetIds,
    });
    return undefined;
  }

  const taskNumbers = buildCoordinatorWorkItemNumbers(managedMetas, workItems);

  type CandidateSession = {
    meta: SessionMeta;
    workItemId: string;
    workItemDoc?: CoordinatorWorkItemDoc;
    taskNumber: number | undefined;
    nextCursor: CoordinatorReadCursorInput;
    priorCursor?: ReturnType<typeof priorCursors.get>;
    msgChanged: boolean;
    prChanged: boolean;
    statusChanged: boolean;
    activityAt: number;
  };

  const candidates: CandidateSession[] = [];
  const nextCursors: CoordinatorReadCursorInput[] = [];

  for (const meta of managedMetas) {
    const workItemId = resolveWorkItemId(meta);
    const workItemDoc = workItems[workItemId];
    const statusSignature = buildStatusSignature(meta, workItemDoc);
    const prSignature = buildPrSignature(meta);
    const activityAt = latestActivityEpochMs(meta);
    const nextCursor: CoordinatorReadCursorInput = {
      targetSessionId: meta.id,
      ...(meta.latestUserMsgId ? { latestUserMsgId: meta.latestUserMsgId } : {}),
      lastMessageAt: activityAt,
      statusSignature,
      prSignature,
    };
    nextCursors.push(nextCursor);

    const prior = priorCursors.get(meta.id);
    const msgChanged = Boolean(
      meta.latestUserMsgId && meta.latestUserMsgId !== prior?.latestUserMsgId
    );
    const prChanged = prior ? prSignature !== prior.prSignature : prSignature.length > 0;
    const statusChanged = prior
      ? statusSignature !== prior.statusSignature
      : Boolean(
          meta.isArchived ||
          (typeof meta.coordinatorTaskAcceptedAt === 'number' &&
            meta.coordinatorTaskAcceptedAt >= activityAt) ||
          (typeof meta.awaitingUserSince === 'number' && meta.awaitingUserSince > 0) ||
          workItemDoc?.mode === 'direct'
        );

    if (msgChanged || prChanged || statusChanged) {
      candidates.push({
        meta,
        workItemId,
        workItemDoc,
        taskNumber: taskNumbers.get(workItemId),
        nextCursor,
        priorCursor: prior,
        msgChanged,
        prChanged,
        statusChanged,
        activityAt,
      });
    }
  }

  candidates.sort((a, b) => b.activityAt - a.activityAt);

  const tailTargets = args.readChildTail
    ? candidates.filter((c) => c.msgChanged).slice(0, MAX_DELTA_TAIL_READ_SESSIONS)
    : [];
  const tailSummaries = new Map<string, ChildDirectTailSummary>();

  if (tailTargets.length > 0 && args.readChildTail) {
    const loaded = await mapWithConcurrency(
      tailTargets,
      MAX_DELTA_CONCURRENT_READS,
      async (candidate) => {
        try {
          const summary = await args.readChildTail!(
            candidate.meta.id,
            candidate.priorCursor?.latestUserMsgId
          );
          return { id: candidate.meta.id, summary };
        } catch {
          return { id: candidate.meta.id, summary: undefined };
        }
      }
    );
    for (const item of loaded) {
      if (item.summary) {
        tailSummaries.set(item.id, item.summary);
      }
    }
  }

  const lines: string[] = [];
  for (const candidate of candidates) {
    const tail = tailSummaries.get(candidate.meta.id);
    const hasDirectTurn = Boolean(tail?.hasNonCoordinatorUserTurn);
    if (!hasDirectTurn && !candidate.prChanged && !candidate.statusChanged) {
      continue;
    }

    const { meta, workItemId, workItemDoc, taskNumber } = candidate;
    const uri = `lody://session/${meta.id}?workspace=${args.workspaceId}`;
    const mode = workItemDoc?.mode ?? 'delegated';
    const title = truncatePlainText(workItemDoc?.title || meta.title || meta.id, 100);
    const latestAt = candidate.activityAt;
    const accepted =
      Boolean(meta.isArchived) ||
      (typeof meta.coordinatorTaskAcceptedAt === 'number' &&
        meta.coordinatorTaskAcceptedAt >= latestAt);
    const awaiting = typeof meta.awaitingUserSince === 'number' && meta.awaitingUserSince > 0;
    const stateLabel = accepted ? 'accepted' : awaiting ? 'awaiting_user' : 'active';

    const attrs = [
      ...(taskNumber !== undefined ? [`task="T${taskNumber}"`] : []),
      `work_item_id="${escapeXmlAttr(workItemId)}"`,
      `mode="${mode}"`,
      `session="${escapeXmlAttr(uri)}"`,
      ...(meta.workItemRole ? [`role="${escapeXmlAttr(meta.workItemRole)}"`] : []),
      `state="${stateLabel}"`,
      `title="${escapeXmlAttr(title)}"`,
    ];

    const detailLines: string[] = [];
    if (candidate.prChanged) {
      const prSummaries = formatPrSummaryList(meta);
      if (prSummaries.length > 0) {
        detailLines.push(`  pull_requests: ${prSummaries.join('; ')}`);
      }
    }
    if (tail && tail.directExchanges.length > 0) {
      for (const ex of tail.directExchanges) {
        detailLines.push(`  direct_user: ${ex.userText}`);
        if (ex.assistantText) {
          detailLines.push(`  child_reply: ${ex.assistantText}`);
        }
      }
    }

    const entryBlock =
      detailLines.length > 0
        ? `<session_update ${attrs.join(' ')}>\n${detailLines.join('\n')}\n</session_update>`
        : `<session_update ${attrs.join(' ')} />`;

    lines.push(entryBlock);
  }

  let deltaText = '';
  if (lines.length > 0) {
    const assembled: string[] = ['<project_facts_delta>'];
    let currentLen = assembled[0]!.length + '\n</project_facts_delta>'.length;
    for (const block of lines) {
      if (currentLen + block.length + 1 > MAX_DELTA_BLOCK_CHARS) break;
      assembled.push(block);
      currentLen += block.length + 1;
    }
    if (assembled.length > 1) {
      assembled.push('</project_facts_delta>');
      deltaText = assembled.join('\n');
    }
  }

  args.cursorStore.commitCoordinatorTurnDelta({
    coordinatorSessionId: args.coordinatorSessionId,
    userTurnId: args.userTurnId,
    deltaText,
    cursors: nextCursors,
    removedTargetIds,
  });

  return deltaText.length > 0 ? deltaText : undefined;
}

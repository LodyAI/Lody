import {
  proposalOf,
  type ProposalPresentation,
} from '../protocol/proposals.ts';
import {
  operationPresentation,
  type OperationPresentation,
} from './operation-presentation.ts';
import {
  type SessionUsage,
  projectSessionUsage,
} from '../protocol/session-usage.ts';
import { presentMessageText } from '../protocol/message-references.ts';
import {
  readTurnMetadata,
  type TurnMetadata,
} from '../protocol/turnMetadata.ts';
import { executionProjection, type SteerReceipt } from './execution';
import type { LoroDoc, LoroList, LoroMap } from 'loro-crdt/base64';
import {
  parseQuestionMeta,
  samePermissionOutcome,
} from '../protocol/permissionQuestions.ts';
import type { QuestionMeta } from '../models/session.ts';
import { billableTurnCount } from './billing';
import { previewSummary } from './preview';

export type SystemNoticeMeta = {
  reason?: string;
  code?: string;
  message?: string;
};

export type ItemSummary =
  | {
      itemId: string;
      rev: number;
      type:
        | 'operation_progress'
        | 'operation_completion'
        | 'operation_completion_batch';
      operation: OperationPresentation;
    }
  | {
      itemId: string;
      rev: number;
      type: 'system_notice';
      name: string;
      meta?: SystemNoticeMeta;
      /** `agent_role_proposal` / `schedule_proposal`, when well-formed. */
      proposal?: ProposalPresentation;
    }
  | { itemId: string; rev: number; type: 'text'; text: string }
  | { itemId: string; rev: number; type: 'thought'; text: string }
  | {
      itemId: string;
      rev: number;
      type: 'proposed_plan';
      turnId: string;
      markdown: string;
      status: 'delta' | 'completed' | 'cleared';
      isLatest: boolean;
    }
  | {
      itemId: string;
      rev: number;
      type: 'tool_call';
      kind: string;
      title: string;
      status: string;
      path?: string;
      added?: number;
      removed?: number;
      hasDetail: boolean;
      /** Plan text a `switch_mode` (plan-approval) card carries; see `planExitMarkdown`. */
      plan?: string;
      permission?: {
        requestId: string;
        pending: boolean;
        options?: { optionId: string; name: string; kind?: string }[];
        kind?: 'permission' | 'ask_user_question';
        questionMeta?: QuestionMeta;
      };
    }
  | {
      itemId: string;
      rev: number;
      type: 'plan';
      entries: { content: string; status: string; priority?: string }[];
    }
  | {
      itemId: string;
      rev: number;
      type: 'subagent_task';
      taskId: string;
      status: string;
      actor?: string;
      description?: string;
      lastToolName?: string;
      summary?: string;
      error?: string;
      isBackgrounded?: boolean;
      skipTranscript?: boolean;
      run?: { sessionId: string; state: string; items: ItemSummary[] };
    }
  | { itemId: string; rev: number; type: string };

export type EntrySummary = TurnMetadata & {
  id: string;
  rev: number;
  role: string;
  status: string;
  finished: boolean;
  userTurnId?: string;
  userId?: string;
  executionId?: string;
  executionFinished?: boolean;
  steerCount?: number;
  delivery?: string;
  holdOpen?: boolean;
  timestamp?: string;
  startedAt?: number;
  endedAt?: number;
  permissionWaitMs?: number;
  modelInfo?: { modelId?: string; name?: string; thoughtLevel?: string };
  items: ItemSummary[];
};

export type Envelope = {
  v: 1;
  status: string;
  reason?: string;
  revision: number;
  billableTurnCount?: number;
  usage?: SessionUsage;
  historyHasMore?: boolean;
  historyLoading?: boolean;
  /** Locally persisted owner inputs whose delivery is still being reconciled. */
  pendingRoostInputs?: readonly Record<string, unknown>[];
  awaitingUserSince?: number;
  preview?: { label: string; active: boolean };
  composer?: {
    modelId?: string;
    modeId?: string;
    effort?: string;
    configOptionValues?: Record<string, string | boolean>;
    /** The Role the latest turn ran as; null after an explicit None (web). */
    agentRoleId?: string | null;
  };
  entries: EntrySummary[];
};

let revision = 0;
type Projection = {
  revs: Map<string, { rev: number; fingerprint: string }>;
  entries: Map<
    string,
    { fingerprint: string; value: EntrySummary & { userTurnId?: string } }
  >;
};
const projections = new WeakMap<LoroDoc, Projection>();
function projectionFor(doc: LoroDoc) {
  let projection = projections.get(doc);
  if (!projection) {
    projection = { revs: new Map(), entries: new Map() };
    projections.set(doc, projection);
  }
  return projection;
}
function bump(projection: Projection, key: string, fingerprint: string) {
  const previous = projection.revs.get(key);
  if (previous && previous.fingerprint === fingerprint) return previous.rev;
  const rev = (previous?.rev ?? 0) + 1;
  projection.revs.set(key, { rev, fingerprint });
  return rev;
}

export function itemRev(doc: LoroDoc, entryId: string, itemId: string) {
  return projectionFor(doc).revs.get(`${entryId}/${itemId}`)?.rev ?? 0;
}

export function identityAt(list: LoroList, index: number) {
  const id = list.getIdAt(index);
  return id ? `${id.peer}:${id.counter}` : `idx:${index}`;
}


/**
 * Plan text carried by a plan-approval (`switch_mode`) card — web
 * `resolvePlanExitMarkdown` (`packages/components/.../plan-surface.ts`).
 * Claude puts it in `rawInput.plan` (its `content` can later be replaced by a
 * status message), Kimi in the first `content` text block; Codex carries none
 * here and renders a separate `proposed_plan` item instead.
 */
function planExitMarkdown(raw: any): string | undefined {
  const rawPlan = raw.rawInput?.plan;
  if (typeof rawPlan === 'string' && rawPlan.trim()) return rawPlan.trim();
  const block = (Array.isArray(raw.content) ? raw.content : []).find(
    (block: any) =>
      block?.type === 'content' &&
      block.content?.type === 'text' &&
      typeof block.content.text === 'string' &&
      block.content.text.trim(),
  );
  return block ? String(block.content.text).trim() : undefined;
}
function countDiff(content: unknown) {
  if (!Array.isArray(content)) return undefined;
  let added = 0,
    removed = 0,
    path: string | undefined;
  for (const block of content) {
    if (!block || block.type !== 'diff') continue;
    path ??= typeof block.path === 'string' ? block.path : undefined;
    const before = String(block.oldText ?? '').split('\n');
    const after = String(block.newText ?? '').split('\n');
    const shared = new Set(before);
    for (const line of after) if (!shared.has(line)) added += 1;
    const target = new Set(after);
    for (const line of before) if (!target.has(line)) removed += 1;
  }
  return path === undefined && added === 0 && removed === 0
    ? undefined
    : { path, added, removed };
}

function summarizeItem(
  projection: Projection,
  raw: any,
  entryId: string,
  identity: string,
  parentItemId?: string,
) {
  const type = String(raw?.type ?? 'unknown');
  const localId =
    type === 'tool_call' && typeof raw.toolCallId === 'string'
      ? raw.toolCallId
      : identity;
  const itemId = parentItemId
    ? JSON.stringify([parentItemId, localId])
    : localId;
  const key = `${entryId}/${itemId}`;

  if (
    [
      'operation_progress',
      'operation_completion',
      'operation_completion_batch',
    ].includes(type)
  ) {
    const operation = operationPresentation(raw);
    return {
      itemId,
      rev: bump(projection, key, JSON.stringify(operation)),
      type,
      operation,
    } as ItemSummary;
  }

  if (type === 'system_notice') {
    const name = typeof raw.name === 'string' ? raw.name : '';
    const meta = {
      reason:
        typeof raw.meta?.reason === 'string' ? raw.meta.reason : undefined,
      code: typeof raw.meta?.code === 'string' ? raw.meta.code : undefined,
      message:
        typeof raw.meta?.message === 'string' ? raw.meta.message : undefined,
    };
    const proposal = proposalOf(name, raw.meta);
    return {
      itemId,
      rev: bump(projection, key, JSON.stringify({ name, meta, proposal })),
      type,
      name,
      meta,
      ...(proposal ? { proposal } : {}),
    };
  }

  if (type === 'text' || type === 'thought') {
    const text = typeof raw.text === 'string' ? raw.text : '';
    return {
      itemId,
      rev: bump(projection, key, text),
      type,
      text,
      ...(raw.references?.length ? { references: raw.references } : {}),
    } as ItemSummary;
  }

  if (type === 'proposed_plan') {
    const plan = {
      turnId: typeof raw.turnId === 'string' ? raw.turnId : '',
      markdown: typeof raw.markdown === 'string' ? raw.markdown : '',
      status:
        raw.status === 'delta' || raw.status === 'completed'
          ? raw.status
          : 'cleared',
      isLatest: raw.isLatest === true,
    };
    return {
      itemId,
      rev: bump(projection, key, JSON.stringify(plan)),
      type,
      ...plan,
    } as ItemSummary;
  }

  if (type === 'image' || type === 'image_group') {
    const sources = type === 'image' ? [raw] : raw.images;
    const images = (Array.isArray(sources) ? sources : [])
      .filter(
        (image: any) =>
          typeof image?.imageId === 'string' && image.imageId.length > 0,
      )
      .map((raw: any) => ({
        id: String(raw.imageId ?? ''),
        fileName: String(raw.fileName ?? '图片'),
        storageSessionId:
          typeof raw.storageSessionId === 'string'
            ? raw.storageSessionId
            : undefined,
        width:
          typeof raw.width === 'number' && raw.width > 0
            ? raw.width
            : undefined,
        height:
          typeof raw.height === 'number' && raw.height > 0
            ? raw.height
            : undefined,
      }));
    const media = type === 'image' ? { image: images[0] } : { images };
    return {
      itemId,
      rev: bump(projection, key, JSON.stringify(media)),
      type,
      ...media,
    } as ItemSummary;
  }
  if (type === 'file') {
    const file = {
      id: String(raw.fileId ?? ''),
      fileName: String(raw.fileName ?? '附件'),
      mimeType:
        typeof raw.mimeType === 'string' && raw.mimeType.length <= 255
          ? raw.mimeType
          : undefined,
      transport: typeof raw.transport === 'string' ? raw.transport : undefined,
      sizeBytes: Number.isSafeInteger(raw.sizeBytes)
        ? raw.sizeBytes
        : undefined,
      storageSessionId:
        typeof raw.storageSessionId === 'string'
          ? raw.storageSessionId
          : undefined,
    };
    return {
      itemId,
      rev: bump(projection, key, JSON.stringify(file)),
      type,
      file,
    } as ItemSummary;
  }

  if (type === 'tool_call') {
    const diff = countDiff(raw.content);
    const plan =
      raw.kind === 'switch_mode' ? planExitMarkdown(raw) : undefined;
    const questionMeta = parseQuestionMeta(raw.permissionRequest?._meta);
    const isQuestion =
      !!questionMeta ||
      raw.permissionRequest?.kind === 'ask_user_question' ||
      raw.kind === 'ask_user_question';
    const permission =
      !parentItemId && raw.permissionRequest
        ? {
            requestId: String(raw.permissionRequest.requestId ?? ''),
            pending: raw.permissionRequest.outcome == null,
            options: raw.permissionRequest.options,
            kind: isQuestion
              ? ('ask_user_question' as const)
              : ('permission' as const),
            questionMeta,
          }
        : undefined;
    const summary = {
      itemId,
      rev: 0,
      type,
      kind: String(raw.kind ?? 'other'),
      title: String(raw.title ?? raw.toolName ?? ''),
      status: String(raw.status ?? 'pending'),
      path: diff?.path,
      added: diff?.added,
      removed: diff?.removed,
      hasDetail:
        (Array.isArray(raw.content) && raw.content.length > 0) ||
        raw.rawInput != null ||
        raw.rawOutput != null,
      ...(plan ? { plan } : {}),
      permission,
    };
    summary.rev = bump(
      projection,
      key,
      JSON.stringify({
        ...summary,
        content: raw.content,
        rawInput: raw.rawInput,
        rawOutput: raw.rawOutput,
      }),
    );
    return summary as ItemSummary;
  }

  if (type === 'plan') {
    const entries = (Array.isArray(raw.entries) ? raw.entries : []).map(
      (e: any) => ({
        content: String(e?.content ?? ''),
        status: String(e?.status ?? 'pending'),
        priority: e?.priority == null ? undefined : String(e.priority),
      }),
    );
    return {
      itemId,
      rev: bump(projection, key, JSON.stringify(entries)),
      type,
      entries,
    } as ItemSummary;
  }

  if (type === 'subagent_task') {
    const summary = {
      itemId,
      rev: 0,
      type,
      taskId: String(raw.taskId ?? itemId),
      status: String(raw.status ?? 'pending'),
      actor: raw.actor == null ? undefined : String(raw.actor),
      description:
        raw.description == null ? undefined : String(raw.description),
      lastToolName:
        raw.lastToolName == null ? undefined : String(raw.lastToolName),
      summary: raw.summary == null ? undefined : String(raw.summary),
      error: raw.error == null ? undefined : String(raw.error),
      isBackgrounded:
        raw.isBackgrounded == null ? undefined : Boolean(raw.isBackgrounded),
      skipTranscript:
        raw.skipTranscript == null ? undefined : Boolean(raw.skipTranscript),
      group: taskGroup(raw),
      run: Array.isArray(raw.run?.items)
        ? {
            sessionId: String(raw.run.sessionId ?? raw.taskId ?? itemId),
            state: String(raw.run.snapshot?.state ?? raw.status ?? 'pending'),
            items: raw.run.items.flatMap((item: any, index: number) => {
              if (
                !['text', 'thought', 'tool_call', 'plan'].includes(item?.type)
              )
                return [];
              return [
                summarizeItem(
                  projection,
                  item,
                  entryId,
                  `run:${index}`,
                  itemId,
                ),
              ];
            }),
          }
        : undefined,
    };
    summary.rev = bump(projection, key, JSON.stringify(summary));
    return summary as ItemSummary;
  }

  return { itemId, rev: bump(projection, key, type), type } as ItemSummary;
}

function summarizeEntry(
  projection: Projection,
  history: LoroList | undefined,
  entry: any,
  index: number,
  pendingOutcomes?: ReadonlyMap<string, unknown>,
) {
  const id = String(
    entry?.id ?? (history ? identityAt(history, index) : `idx:${index}`),
  );
  const fallbackItemId = (itemIndex: number) => {
    if (history) return `idx:${index}:${itemIndex}`;
    return `idx:${id}:${itemIndex}`;
  };
  if (pendingOutcomes?.size && Array.isArray(entry?.items)) {
    const container = history?.get(index) as LoroMap | undefined;
    const items =
      container && typeof container.get === 'function'
        ? (container.get('items') as LoroList)
        : undefined;
    entry = {
      ...entry,
      items: entry.items.map((item: any, i: number) => {
        const request = item?.permissionRequest;
        let itemId = fallbackItemId(i);
        if (items && typeof items.getIdAt === 'function')
          itemId = identityAt(items, i);
        if (item?.type === 'tool_call' && typeof item.toolCallId === 'string')
          itemId = item.toolCallId;
        // A proposal decision whose upload is unconfirmed stays undecided, so it can be retried.
        if (
          item?.type === 'system_notice' &&
          pendingOutcomes.has(`${id}/${itemId}/notice`)
        ) {
          const { outcome: _outcome, ...meta } = item.meta ?? {};
          return { ...item, meta };
        }
        const key = `${id}/${itemId}/${request?.requestId}`;
        if (
          !pendingOutcomes.has(key) ||
          !samePermissionOutcome(request?.outcome, pendingOutcomes.get(key))
        )
          return item;
        return { ...item, permissionRequest: { ...request, outcome: null } };
      }),
    };
  }
  const fingerprint = JSON.stringify(entry);
  const cached = projection.entries.get(id);
  if (cached && cached.fingerprint === fingerprint) return cached.value;
  const container = history?.get(index) as LoroMap | undefined;
  const items =
    container && typeof (container as any).get === 'function'
      ? ((container as any).get('items') as LoroList | undefined)
      : undefined;
  const list = Array.isArray(entry?.items) ? entry.items : [];
  const summarizedItems: ItemSummary[] = list.map((item: any, i: number) =>
    summarizeItem(
      projection,
      entry.role === 'user' && item?.type === 'text'
        ? { ...item, ...presentMessageText(item.text ?? '', item.spans) }
        : item,
      id,
      items && typeof items.getIdAt === 'function'
        ? identityAt(items, i)
        : fallbackItemId(i),
    ),
  );
  const fileDiffs = (Array.isArray(entry?.fileDiff) ? entry.fileDiff : [])
    .filter((diff: any) => diff && typeof diff.filePath === 'string')
    .map((diff: any) => ({
      path: String(diff.filePath),
      add: Number(diff.add) || 0,
      del: Number(diff.del) || 0,
    }));
  const model = entry?.modelInfo;
  const modelInfo = {
    modelId:
      typeof model?.modelId === 'string' ? model.modelId.trim() : undefined,
    name: typeof model?.name === 'string' ? model.name.trim() : undefined,
    thoughtLevel:
      typeof model?._meta?.lodyThoughtLevel === 'string'
        ? model._meta.lodyThoughtLevel.trim()
        : undefined,
  };
  const metadata = readTurnMetadata(entry);
  const value = {
    ...metadata,
    id,
    rev: bump(
      projection,
      `entry/${id}`,
      summarizedItems.map((i) => `${i.itemId}:${i.rev}`).join(',') +
        `|${entry?.status}|${entry?.finished}|${JSON.stringify(fileDiffs)}|${JSON.stringify(modelInfo)}|${JSON.stringify(metadata)}`,
    ),
    role: String(entry?.role ?? 'assistant'),
    status: entry?.status ?? (entry?.read ? 'seen' : 'pending'),
    finished: entry?.finished === true,
    timestamp: entry?.timestamp,
    startedAt: entry?.startedAt,
    endedAt: entry?.endedAt,
    permissionWaitMs: entry?.permissionWaitMs,
    modelInfo: modelInfo.name || modelInfo.modelId ? modelInfo : undefined,
    userTurnId: entry?.userTurnId,
    // Who sent a user turn, for its avatar and name.
    userId: typeof entry?.userId === 'string' ? entry.userId : undefined,
    items: summarizedItems,
    ...(fileDiffs.length ? { fileDiffs } : {}),
  };
  projection.entries.set(id, { fingerprint, value });
  return value;
}

/** Use the ordinary transcript projection for locally pending upstream inputs. */
export function projectPendingInputs(
  doc: LoroDoc,
  entries: readonly unknown[],
) {
  return entries.map((entry, index) =>
    summarizeEntry(projectionFor(doc), undefined, entry, index),
  );
}

export function projectSession(
  doc: LoroDoc,
  status: string,
  reason?: string,
  pendingOutcomes?: ReadonlyMap<string, unknown>,
  steerReceipts?: ReadonlyMap<string, SteerReceipt>,
  historyOverride?: readonly unknown[],
  historyMetadata?: readonly Record<string, unknown>[],
): Envelope {
  const history = historyOverride
    ? undefined
    : (doc.getList('history') as LoroList);
  const links = doc.getMap('lodySteerLinks').toJSON() as Record<string, any>;
  const configFor = (id: string, input: any) => {
    const link = links[id];
    if (
      !link ||
      typeof link.targetId !== 'string' ||
      !['interrupt', 'native'].includes(link.mode)
    )
      return input;
    return {
      ...input,
      _lodyDeliveryKind: 'steer',
      _lodySteerTarget: link.targetId,
      _lodySteerMode: link.mode,
    };
  };
  const raw = ((historyOverride ?? history!.toJSON()) as any[]).map(
    (entry) => ({
      ...entry,
      inputConfig: configFor(entry.id, entry.inputConfig),
    }),
  );
  const input =
    raw.findLast((entry) => entry?.role === 'user')?.inputConfig ??
    historyMetadata?.findLast((entry) => entry.role === 'user')?.inputConfig;
  const options =
    input?.configOptionValues && typeof input.configOptionValues === 'object'
      ? input.configOptionValues
      : {};
  // Restore agent-specific permission selectors as well as Fast. Effort has
  // its own composer field, so a model change can clear it independently.
  const composerValues = Object.fromEntries(
    Object.entries(
      readTurnMetadata({ inputConfig: input }).inputConfig
        ?.configOptionValues ?? {},
    ).filter(([id]) => id !== 'effort' && id !== 'reasoning_effort'),
  );
  const effort = [options.reasoning_effort, options.effort].find(
    (value) => typeof value === 'string',
  );
  const summarized = raw.map((entry, index) =>
    summarizeEntry(projectionFor(doc), history, entry, index, pendingOutcomes),
  );

  // A daemon history-sync timeout can place a concurrent reply before its input.
  // Use its explicit causal link; never sort streamed turns by arrival time.
  const userIds = new Set(
    summarized.filter((e) => e.role === 'user').map((e) => e.id),
  );
  const replies = new Map<string, typeof summarized>();
  for (const entry of summarized)
    if (entry.role === 'assistant' && userIds.has(entry.userTurnId!)) {
      const group = replies.get(entry.userTurnId!) ?? [];
      group.push(entry);
      replies.set(entry.userTurnId!, group);
    }
  const ordered = summarized.flatMap((entry) =>
    entry.role === 'assistant' && userIds.has(entry.userTurnId!)
      ? []
      : [
          entry,
          ...(entry.role === 'user' ? (replies.get(entry.id) ?? []) : []),
        ],
  );

  const queued = (doc.getMovableList('mq').toJSON() as any[]).map((item) => ({
    ...item,
    acpSessionConfig: configFor(item.userTurnId, item.acpSessionConfig),
  }));
  const execution = executionProjection(
    [
      ...raw,
      ...queued
        .filter((item) => !userIds.has(item.userTurnId))
        .map((item) => ({
          id: item.userTurnId,
          role: 'user',
          status:
            item.acpSessionConfig?._lodySteerMode === 'interrupt'
              ? 'pending_apply'
              : 'queued',
          inputConfig: item.acpSessionConfig,
        })),
    ],
    status === 'live',
    steerReceipts,
  );
  revision += 1;
  const session = doc.getMap('session').toJSON();
  return {
    v: 1,
    status,
    reason,
    revision,
    usage: projectSessionUsage(session, raw),
    billableTurnCount: billableTurnCount({ history: raw, mq: queued }),
    awaitingUserSince:
      typeof session?.awaitingUserSince === 'number'
        ? session.awaitingUserSince
        : undefined,
    preview: previewSummary(doc),
    ...(input
      ? {
          composer: {
            ...(typeof input.modelId === 'string'
              ? { modelId: input.modelId }
              : {}),
            ...(typeof input.modeId === 'string'
              ? { modeId: input.modeId }
              : {}),
            ...(typeof effort === 'string' ? { effort } : {}),
            ...(Object.keys(composerValues).length
              ? { configOptionValues: composerValues }
              : {}),
            ...(typeof input.agentRoleId === 'string' ||
            input.agentRoleId === null
              ? { agentRoleId: input.agentRoleId }
              : {}),
          },
        }
      : {}),
    entries: [
      ...ordered.map((entry) => ({ ...entry, ...execution.get(entry.id) })),
      ...queued
        .filter(
          (item) =>
            typeof item.userTurnId === 'string' &&
            !userIds.has(item.userTurnId),
        )
        .map((item) => ({
          id: item.userTurnId,
          role: 'user',
          status:
            item.acpSessionConfig?._lodySteerMode === 'interrupt'
              ? 'pending_apply'
              : 'queued',
          ...execution.get(item.userTurnId),
          finished: false,
          rev: 0,
          timestamp: item.timestamp,
          items: (
            item.acpSessionConfig?.inputBlocks ?? [
              { type: 'text', text: item.task },
            ]
          ).map((block: any, index: number) =>
            summarizeItem(
              projectionFor(doc),
              block?.type === 'text'
                ? {
                    ...block,
                    ...presentMessageText(block.text ?? '', block.spans),
                  }
                : block,
              item.userTurnId,
              `queue:${index}`,
            ),
          ),
        })),
    ],
  };
}

/**
 * Web `groupOf` (`subagent-task-state.tsx`): a scheduled wakeup is a task; anything with a
 * subagent type or a run is a subagent; else a shell command, MCP task or monitor is a task and
 * an unrecognised type stays with the subagents.
 */
const NON_AGENT_TASK_TYPES = new Set(['local_bash', 'mcp_task', 'monitor_mcp']);
function taskGroup(raw: any): 'subagents' | 'tasks' {
  if (raw?.taskKind === 'scheduled') return 'tasks';
  if (raw?.subagentType || raw?.run) return 'subagents';
  const type = raw?.taskType ?? raw?.actor;
  return typeof type === 'string' && NON_AGENT_TASK_TYPES.has(type)
    ? 'tasks'
    : 'subagents';
}

import type { SessionUsage } from '../protocol/session-usage.ts';
import type { MessageReference } from '../protocol/message-references.ts';
import { LoroDoc, LoroMap, LoroList, LoroText } from 'loro-crdt/base64';
import { StreamsClient } from '@loro-dev/streams-client';
import { decompress } from 'fzstd';
import { decodeFrames, encodeFrame } from '../frames';
import { identityAt, itemRev, projectSession } from './project';
import type { SteerReceipt } from './execution';
import { machineRpc, type RpcReply } from './machine-rpc';
import { retrySessionRead } from './session-read';
import { resolveTurnRole, type TurnRole } from './agent-roles';
import { roleRunConfigApplied } from '../protocol/agent-roles';
import type {
  CheckTurnQuotaResult,
  ControlTurnResult,
  EditSessionResult,
  SendTurnResult,
  SessionRuntimeEvent,
  SessionTrace,
} from '../contract/methods.ts';
import {
  editableUserTurn,
  editAttachments,
  replacementInput,
} from './edit-session';
import {
  billableTurnCount,
  quotaReason,
  type BillingEntitlement,
} from './billing';
import {
  parseQuestionMeta,
  questionOutcome,
  samePermissionOutcome,
} from '../protocol/permissionQuestions.ts';
export { projectSession } from './project';

type Grant = { token: string; gatewayBaseUrl: string };
export const MAX_BACKGROUND_SESSION_SYNCS = 3;
type SessionState = {
  id: string;
  workspace: string;
  doc: LoroDoc;
  client: StreamsClient;
  controller: AbortController;
  ready: boolean;
  sending: boolean;
  working?: boolean;
  sendingId?: string;
  steerReceipts?: Map<string, SteerReceipt>;
  backgroundWork?: { id: string; turnId: string };
  status: string;
  reason?: string;
  pending?: ReturnType<typeof setTimeout>;
  firstQueuedAt: number;
  lastSignal: string;
  lastUsage?: string;
  unsent: Map<
    string,
    {
      version: ReturnType<LoroDoc['version']>;
      outcome: Record<string, unknown>;
    }
  >;
  getGrant: () => Promise<Grant>;
  markDispatch: (
    sessionId: string,
    turnId: string,
    queued?: boolean,
  ) => Promise<void>;
  emit: (event: SessionRuntimeEvent) => void;
  liveWaiters?: Array<(error?: Error) => void>;
  read?: { stage: ReadStage; startedAt: number; stalled?: boolean };
  readFailures: number;
};
type ReadStage = 'bootstrap' | 'catchup' | 'poll';
const readLimit: Record<ReadStage, number> = {
  bootstrap: 15_000,
  catchup: 15_000,
  poll: 35_000,
};
const stallGrace = 15_000;
let active: SessionState | undefined;
// Working sessions use visit order; idle visits never enter the background LRU.
const sessions = new Map<string, SessionState>();
const reserved = new Set<string>();
export const retainedSessionIds = () => [...sessions.keys()];
export const reservedSessionIds = () => [...reserved];
export const sessionDoc = (id: string) => sessions.get(id)?.doc;
/** Full persisted history of a synchronized session, for whole-conversation exports. */
export function readyHistory(id: string): Record<string, any>[] {
  const state = sessions.get(id);
  if (!state?.ready) throw new Error('session_not_ready');
  return state.doc.getList('history').toJSON() as Record<string, any>[];
}
function traceCode(value: unknown) {
  const pattern = /^[a-z][a-z0-9_]{0,47}$/;
  if (typeof value === 'string') return pattern.test(value) ? value : undefined;
  if (!(value instanceof Error)) return undefined;
  if (pattern.test(value.message)) return value.message;
  return value.name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .slice(0, 48);
}
let traceSink: (event: SessionTrace) => void = () => {};
export function setSessionTraceSink(sink: typeof traceSink) {
  traceSink = sink;
}
function trace(
  state: SessionState,
  event: SessionTrace['event'],
  fields: Omit<SessionTrace, 'sessionId' | 'event'> = {},
) {
  traceSink({ sessionId: state.id, event, ...fields });
}
async function readAttempt<T>(
  state: SessionState,
  stage: ReadStage,
  read: () => Promise<T>,
) {
  const attempt = { stage, startedAt: Date.now() };
  state.read = attempt;
  try {
    const result = await read();
    const ageMs = Date.now() - attempt.startedAt;
    if (ageMs > readLimit[stage] + stallGrace)
      trace(state, 'slow', { stage, ageMs, attempts: state.readFailures + 1 });
    state.readFailures = 0;
    return result;
  } catch (error) {
    if (!state.controller.signal.aborted) {
      state.readFailures += 1;
      trace(state, 'retry', {
        stage,
        code: traceCode(error),
        ageMs: Date.now() - attempt.startedAt,
        attempts: state.readFailures,
      });
    }
    throw error;
  } finally {
    if (state.read === attempt) state.read = undefined;
  }
}
export function traceStalledReads(now = Date.now()) {
  for (const state of sessions.values()) {
    const read = state.read;
    if (!read || read.stalled) continue;
    const ageMs = now - read.startedAt;
    if (ageMs < readLimit[read.stage] + stallGrace) continue;
    read.stalled = true;
    trace(state, 'stalled', { stage: read.stage, ageMs, status: state.status });
  }
}
export function traceSessionResume() {
  const state = active;
  if (!state) return;
  const read = state.read;
  trace(state, 'resume', {
    status: state.status,
    ...(read ? { stage: read.stage, ageMs: Date.now() - read.startedAt } : {}),
  });
}
function signalOf(state: SessionState, status: string) {
  const history = state.doc.getList('history');
  let finished = 0;
  for (let i = 0; i < history.length; i++) {
    const entry = history.get(i);
    if (entry instanceof LoroMap && entry.get('finished') === true) finished++;
  }
  const awaiting = state.doc.getMap('session').get('awaitingUserSince') != null;
  return `${status}|${awaiting}|${finished}`;
}
function backgroundStatus(
  state: SessionState,
  reply: { finished?: boolean } | undefined,
) {
  if (state.status === 'offline') return 'failed';
  if (state.status !== 'live') return 'syncing';
  if (!reply) return 'sent';
  if (reply.finished === true) return 'completed';
  if (state.doc.getMap('session').get('awaitingUserSince') != null)
    return 'waiting';
  return 'receiving';
}
function backgroundProgress(state: SessionState) {
  const work = state.backgroundWork;
  if (!work) return undefined;
  const history = state.doc.getList('history').toJSON() as any[];
  const reply = history.findLast(
    (entry) => entry?.role === 'assistant' && entry.userTurnId === work.turnId,
  );
  const status = backgroundStatus(state, reply);
  if (['completed', 'waiting', 'failed'].includes(status))
    state.backgroundWork = undefined;
  return { id: work.id, state: status } as const;
}
type QuotaProjection = Pick<
  SessionUsage,
  'quota' | 'quotaEligible' | 'modelId' | 'modelLabel'
>;
let readUsage: (
  sessionId: string,
  modelId?: string,
) => QuotaProjection = () => ({ quota: null, quotaEligible: false });
export function setSessionUsageReader(read: typeof readUsage) {
  readUsage = read;
}
/** Catalog updates reuse retained session owners; no new stream or timer. */
export function refreshSessionUsage() {
  for (const state of sessions.values()) {
    const history = state.doc.getList('history').toJSON() as any[];
    const modelId = history.findLast((e) => e?.role === 'user')?.inputConfig
      ?.modelId;
    const usage = JSON.stringify(readUsage(state.id, modelId));
    if (usage !== state.lastUsage) flush(state);
  }
}
function flush(state: SessionState) {
  clearTimeout(state.pending);
  state.pending = undefined;
  state.firstQueuedAt = 0;
  if (sessions.get(state.id) !== state) return;
  const snapshot = projectSession(
    state.doc,
    state.status,
    state.reason,
    new Map([...state.unsent].map(([key, pending]) => [key, pending.outcome])),
    state.steerReceipts,
  );
  const quota = readUsage(state.id, snapshot.composer?.modelId);
  state.lastUsage = JSON.stringify(quota);
  if (snapshot.usage) snapshot.usage = { ...snapshot.usage, ...quota };
  state.emit({
    type: active === state ? 'session' : 'sessionCache',
    sessionId: state.id,
    synced: state.status === 'live',
    backgroundWork: backgroundProgress(state),
    session: JSON.stringify(snapshot),
  });
}
function isWorking(state: SessionState) {
  if (state.doc.getMovableList('mq').length) return true;
  const history = state.doc.getList('history');
  let replied = false;
  let latestUser = true;
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history.get(i);
    const get = (key: string) =>
      entry instanceof LoroMap ? entry.get(key) : (entry as any)?.[key];
    if (get('role') === 'assistant') {
      if (!get('finished')) return true;
      replied = true;
    }
    if (get('role') === 'user' && latestUser) {
      // A submitted turn is working before its first assistant event arrives.
      if (
        !replied &&
        ['pending', 'seen', 'processing', 'pending_apply'].includes(
          get('status'),
        )
      )
        return true;
      latestUser = false;
    }
  }
  return false;
}
function scheduleEmit(state: SessionState, status: string, reason?: string) {
  if (status !== state.status && sessions.get(state.id) === state)
    trace(state, 'status', { status, code: traceCode(reason) });
  state.status = status;
  state.reason = reason;
  if (sessions.get(state.id) !== state) return;
  if (state.ready) {
    const working = isWorking(state);
    if (working && state.working !== true) {
      sessions.delete(state.id);
      sessions.set(state.id, state);
    }
    state.working = working;
    trimSessions();
    if (sessions.get(state.id) !== state) return;
  }
  clearTimeout(state.pending);
  const now = Date.now();
  const foreground = active === state;
  const signal = foreground ? signalOf(state, status) : '';
  const maxDelay = foreground ? 200 : 1000;
  if (
    (foreground && signal !== state.lastSignal) ||
    (state.firstQueuedAt && now - state.firstQueuedAt >= maxDelay)
  ) {
    state.lastSignal = signal;
    flush(state);
    return;
  }
  if (!state.firstQueuedAt) state.firstQueuedAt = now;
  state.pending = setTimeout(() => flush(state), foreground ? 100 : 1000);
}
function settleLive(state: SessionState, error?: Error) {
  const waiters = state.liveWaiters;
  state.liveWaiters = undefined;
  waiters?.forEach((waiter) => waiter(error));
}
function evict(state: SessionState) {
  settleLive(state, new Error('session_not_ready'));
  // Publish completion before retiring an idle replica's background allowance.
  if (state.ready) flush(state);
  if (state.backgroundWork) {
    state.emit({
      type: 'sessionCache',
      sessionId: state.id,
      backgroundWork: { id: state.backgroundWork.id, state: 'failed' },
    });
    state.backgroundWork = undefined;
  }
  clearTimeout(state.pending);
  state.controller.abort();
  sessions.delete(state.id);
}
function trimSessions() {
  const before = sessions.size;
  const notify = (active ?? sessions.values().next().value)?.emit;
  const background: SessionState[] = [];
  for (const state of sessions.values()) {
    if (state === active || reserved.has(state.id)) continue;
    if (state.working === false) evict(state);
    else if (state.working === true) background.push(state);
  }
  for (const state of background.slice(0, -MAX_BACKGROUND_SESSION_SYNCS))
    evict(state);
  if (sessions.size !== before)
    notify?.({
      type: 'sessionSubscriptions',
      ids: retainedSessionIds(),
      reserved: reservedSessionIds(),
    });
}
export function closeSession() {
  if (active?.working === undefined && active && !reserved.has(active.id))
    evict(active);
  active = undefined;
  trimSessions();
}
export function releaseDeletedSessions(ids: string[]) {
  for (const id of ids) {
    reserved.delete(id);
    const state = sessions.get(id);
    if (active === state) active = undefined;
    if (state) evict(state);
  }
}
export function releaseReserve(id: string) {
  if (!reserved.delete(id)) return;
  const state = sessions.get(id);
  if (state) {
    sessions.delete(id);
    sessions.set(id, state);
  }
  trimSessions();
}
export function stopSessions() {
  for (const state of sessions.values()) {
    clearTimeout(state.pending);
    state.controller.abort();
  }
  sessions.clear();
  reserved.clear();
  active = undefined;
}
export function unpack(bytes: Uint8Array) {
  return bytes[0] === 0x28 &&
    bytes[1] === 0xb5 &&
    bytes[2] === 0x2f &&
    bytes[3] === 0xfd
    ? decompress(bytes)
    : bytes;
}
export function importUpdates(doc: LoroDoc, bytes: Uint8Array) {
  for (const frame of decodeFrames(bytes)) doc.import(frame);
}
export async function clientFor(id: string, getGrant: () => Promise<Grant>) {
  const grant = await getGrant();
  return new StreamsClient({
    url: `${grant.gatewayBaseUrl.replace(/\/$/, '')}/ds/lody/${encodeURIComponent(id)}`,
    auth: async () => (await getGrant()).token,
    retry: { maxAttempts: 1 },
    timeout: { connectTimeoutMs: 15000, pollTimeoutMs: 35000 },
  });
}
export async function ensureSession(
  id: string,
  workspace: string,
  getGrant: () => Promise<Grant>,
  emit: (event: SessionRuntimeEvent) => void,
  markDispatch: (
    sessionId: string,
    turnId: string,
    queued?: boolean,
  ) => Promise<void>,
) {
  if ([...sessions.values()].some((state) => state.workspace !== workspace))
    stopSessions();
  reserved.add(id);
  const result = await openSession(
    id,
    workspace,
    getGrant,
    emit,
    markDispatch,
    false,
  );
  const state = sessions.get(id);
  if (!state) throw new Error('session_not_ready');
  if (state.ready) return result;
  await new Promise<void>((resolve, reject) => {
    const done = (error?: Error) => {
      state.liveWaiters = state.liveWaiters?.filter((item) => item !== done);
      if (error) reject(error);
      else resolve();
    };
    (state.liveWaiters ??= []).push(done);
    if (state.controller.signal.aborted) {
      done(new Error('session_not_ready'));
      return;
    }
    state.controller.signal.addEventListener(
      'abort',
      () => done(new Error('session_not_ready')),
      { once: true },
    );
  });
  return result;
}
export async function openSession(
  id: string,
  workspace: string,
  getGrant: () => Promise<Grant>,
  emit: (event: SessionRuntimeEvent) => void,
  markDispatch: (
    sessionId: string,
    turnId: string,
    queued?: boolean,
  ) => Promise<void>,
  activate = true,
) {
  if ([...sessions.values()].some((state) => state.workspace !== workspace))
    stopSessions();
  const existing = sessions.get(id);
  if (
    activate &&
    active &&
    active !== existing &&
    active.working === undefined &&
    !reserved.has(active.id)
  )
    evict(active);
  if (existing && existing.status !== 'offline') {
    existing.emit = emit;
    if (activate) {
      active = existing;
      sessions.delete(id);
      sessions.set(id, existing);
    }
    trimSessions();
    flush(existing);
    return 'watching';
  }
  if (existing) evict(existing);
  const controller = new AbortController();
  const state: SessionState = {
    id,
    workspace,
    doc: new LoroDoc(),
    client: undefined as unknown as StreamsClient,
    controller,
    ready: false,
    sending: false,
    status: 'syncing',
    firstQueuedAt: 0,
    lastSignal: '',
    unsent: new Map(),
    getGrant,
    markDispatch,
    emit,
    readFailures: 0,
  };
  if (activate) active = state;
  sessions.set(id, state);
  trimSessions();
  const event = (status: string, reason?: string) => {
    scheduleEmit(state, status, reason);
  };
  const retrying = (error: unknown) => {
    state.ready = false;
    event('syncing', error instanceof Error ? error.message : 'sync_failed');
  };
  event('syncing');
  void (async () => {
    try {
      const data = await retrySessionRead(
        controller.signal,
        () =>
          readAttempt(state, 'bootstrap', async () => {
            state.client = await clientFor(`${workspace}:s:${id}`, getGrant);
            controller.signal.throwIfAborted();
            const initial = await state.client.bootstrap({
              signal: controller.signal,
            });
            if (!initial.ok) throw new Error(initial.result.code);
            return initial.result;
          }),
        retrying,
      );
      if (sessions.get(id) !== state) return;
      let size = 0;
      const consume = (bytes: Uint8Array, snapshot = false) => {
        size += bytes.length;
        if (size > 32 * 1024 * 1024) throw new Error('session_limit');
        if (snapshot) state.doc.import(unpack(bytes));
        else importUpdates(state.doc, bytes);
      };
      if (data.snapshotOffset !== '-1' && data.snapshot)
        consume(data.snapshot.body, true);
      for (const part of data.updates) consume(part.body);
      let pages = 0;
      let changed = true;
      let offset = data.nextOffset,
        cursor = data.cursor,
        upToDate = data.upToDate;
      while (!controller.signal.aborted) {
        state.ready = upToDate;
        if (upToDate) {
          settleLive(state);
          if (changed || state.status !== 'live') event('live');
          changed = false;
          pages = 0;
        } else {
          event('syncing');
          if (++pages > 100) throw new Error('session_limit');
        }
        const next = await retrySessionRead(
          controller.signal,
          () =>
            readAttempt(state, upToDate ? 'poll' : 'catchup', async () => {
              const result = await state.client.readOnce({
                offset,
                cursor,
                signal: controller.signal,
                ...(upToDate ? { live: 'long-poll' as const } : {}),
              });
              if (!result.ok) throw new Error(result.result.code);
              return result;
            }),
          retrying,
        );
        if (sessions.get(id) !== state) return;
        if (next.result.payload) {
          consume(next.result.payload.body);
          changed = true;
        }
        if (next.result.nextOffset === offset && !next.result.upToDate)
          throw new Error('stalled_cursor');
        offset = next.result.nextOffset;
        cursor = next.result.cursor;
        upToDate = next.result.upToDate;
        if (next.result.closed) throw new Error('stream_closed');
        if (!next.result.payload?.body.length && upToDate)
          await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } catch (error) {
      const failed = error instanceof Error ? error : new Error('sync_failed');
      settleLive(state, failed);
      if (controller.signal.aborted || sessions.get(id) !== state) return;
      state.ready = false;
      event('offline', failed.message);
    }
  })();
  return 'watching';
}
export function appendUserTurn(
  doc: LoroDoc,
  id: string,
  text: string,
  userId: string,
  config: Record<string, any>,
  timestamp: string,
  status = 'pending',
) {
  const history = doc.getList('history');
  const entry = history.pushContainer(new LoroMap());
  for (const [key, value] of Object.entries({
    id,
    role: 'user',
    userId,
    timestamp,
    status,
    read: false,
    finished: true,
    fileDiff: [],
  }))
    entry.set(key, value);
  const items = entry.setContainer('items', new LoroList());
  for (const block of config.inputBlocks ?? [{ type: 'text', text }]) {
    const item = items.pushContainer(new LoroMap());
    for (const [key, value] of Object.entries(block)) {
      if (key === 'text')
        item.setContainer('text', new LoroText()).insert(0, String(value));
      else if (value !== undefined) item.set(key, value);
    }
  }
  const input = entry.setContainer('inputConfig', new LoroMap());
  for (const [key, value] of Object.entries(config))
    if (value !== undefined) input.set(key, value);
  doc.commit();
}
export function checkTurnQuota(args: {
  sessionId: string;
  billingEntitlement?: BillingEntitlement | null;
}): CheckTurnQuotaResult {
  const state = sessions.get(args.sessionId);
  if (!state?.ready) return { state: 'allowed' };
  const reason = quotaReason(
    'turn',
    args.billingEntitlement,
    billableTurnCount(state.doc.toJSON()),
  );
  return reason ? { state: 'not_sent', reason } : { state: 'allowed' };
}

export async function sendTurn(
  args: {
    id?: string;
    backgroundTaskId?: string;
    queue?: boolean;
    guide?: boolean;
    sessionId: string;
    machineId: string;
    userId?: string;
    text: string;
    attachmentBlocks?: Record<string, any>[];
    cliType?: string;
    agentType?: string;
    resume?: string;
    modelId?: string | null;
    modeId?: string;
    reasoningEffort?: string | null;
    reasoningEffortConfigId?: string;
    configOptionValues?: Record<string, unknown>;
    /**
     * The Role this turn runs as (resolved here, see `resolveTurnRole`); null is an explicit
     * None that ends the conversation's Role, and undefined inherits it.
     */
    agentRoleId?: string | null;
    /** The session's own Agent Config, from trusted state (meta / the creator), never the wire. */
    agentConfigId?: string;
    billingEntitlement?: BillingEntitlement | null;
  },
  expand: (
    text: string,
  ) => Promise<string | { text: string; spans: MessageReference[] }> = async (
    text,
  ) => text,
  selectMcp: (persisted: unknown) => Promise<string[]> = async (ids) =>
    Array.isArray(ids) ? ids : [],
): Promise<SendTurnResult> {
  const state = sessions.get(args.sessionId);
  if (!state || !state.ready)
    return { state: 'not_sent', reason: 'session_not_ready' };
  if (
    args.id !== undefined &&
    (typeof args.id !== 'string' ||
      !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(args.id))
  )
    return { state: 'not_sent', reason: 'invalid_message_id' };
  if (
    args.id &&
    (state.sendingId === args.id ||
      [
        ...((state.doc.toJSON().history as any[]) ?? []),
        ...((state.doc.toJSON().mq as any[]) ?? []).map((item) => ({
          id: item.userTurnId,
        })),
      ].some((entry) => entry.id === args.id))
  )
    // The local entry may come from a lost append ACK. Never replay its write.
    return { id: args.id, state: 'unknown', reason: 'turn_already_exists' };
  if (state.sending) return { state: 'not_sent', reason: 'session_not_ready' };
  const quota = checkTurnQuota(args);
  if (quota.state === 'not_sent') return quota;
  if (typeof args.text !== 'string')
    return { state: 'not_sent', reason: 'invalid_message' };
  let text = args.text.trim();
  if (
    args.configOptionValues !== undefined &&
    (!args.configOptionValues ||
      typeof args.configOptionValues !== 'object' ||
      Array.isArray(args.configOptionValues) ||
      Object.keys(args.configOptionValues).length > 64 ||
      Object.entries(args.configOptionValues).some(
        ([id, value]) =>
          !id ||
          id.length > 128 ||
          /(?:api[_-]?key|auth|bearer|credential|password|passwd|secret|token)/i.test(
            id,
          ) ||
          !(
            typeof value === 'boolean' ||
            (typeof value === 'string' &&
              value.length > 0 &&
              value.length <= 512)
          ),
      ))
  )
    return { state: 'not_sent', reason: 'invalid_config_options' };
  const attachments = args.attachmentBlocks ?? [];
  if (
    !Array.isArray(attachments) ||
    attachments.length > 16 ||
    attachments.some(
      (block) =>
        !block ||
        !['image', 'file'].includes(block.type) ||
        typeof block[block.type === 'image' ? 'imageId' : 'fileId'] !==
          'string' ||
        !block[block.type === 'image' ? 'imageId' : 'fileId'] ||
        typeof block.mimeType !== 'string' ||
        !Number.isInteger(block.sizeBytes) ||
        block.sizeBytes <= 0 ||
        (block.type === 'file' &&
          (block.transport !== 'r2' ||
            typeof block.sha256 !== 'string' ||
            typeof block.fileName !== 'string' ||
            typeof block.textPreview !== 'boolean' ||
            typeof block.uploadedAt !== 'number')),
    )
  )
    return { state: 'not_sent', reason: '附件信息无效，请重新选择' };
  if (
    (!text && !attachments.length) ||
    text.length > 32000 ||
    !args.userId ||
    !args.machineId ||
    !args.agentType ||
    !args.cliType ||
    (args.reasoningEffort !== undefined &&
      args.reasoningEffort !== null &&
      (typeof args.reasoningEffort !== 'string' ||
        !args.reasoningEffort ||
        args.reasoningEffort.length > 128)) ||
    (args.reasoningEffortConfigId !== undefined &&
      (typeof args.reasoningEffortConfigId !== 'string' ||
        !args.reasoningEffortConfigId ||
        args.reasoningEffortConfigId.length > 128))
  )
    return { state: 'not_sent', reason: 'invalid_message' };
  const id = args.id ?? crypto.randomUUID(),
    timestamp = new Date().toISOString();
  reserved.add(state.id);
  state.sending = true;
  state.sendingId = id;
  let uploaded = false;
  let writeStarted = false;
  try {
    const expanded = await expand(text);
    text = typeof expanded === 'string' ? expanded : expanded.text;
    const spans = typeof expanded === 'string' ? undefined : expanded.spans;
    if (sessions.get(state.id) !== state || !state.ready)
      throw new Error('session_not_ready');
    if (text.length > 32000) throw new Error('invalid_message');
    const previous =
      (state.doc.toJSON().history as any[] | undefined)?.findLast(
        (entry) => entry.role === 'user',
      )?.inputConfig ?? {};
    const configOptionValues = {
      ...(previous.configOptionValues &&
      typeof previous.configOptionValues === 'object' &&
      !Array.isArray(previous.configOptionValues)
        ? previous.configOptionValues
        : {}),
      ...args.configOptionValues,
    };
    if (args.reasoningEffort !== undefined) {
      const id = args.reasoningEffortConfigId || 'reasoning_effort';
      if (args.reasoningEffort === null) delete configOptionValues[id];
      else configOptionValues[id] = args.reasoningEffort;
    }
    // A Role runs a turn only while every value it pins is what will run (web). Any turn
    // may pick one, but its prompt prefix only ever starts the conversation.
    let role: TurnRole | undefined;
    const started = (
      (state.doc.toJSON().history as any[] | undefined) ?? []
    ).some((entry) => entry.role === 'user');
    if (args.agentRoleId !== undefined && args.agentRoleId !== null) {
      if (
        typeof args.agentRoleId !== 'string' ||
        !args.agentRoleId ||
        !args.agentConfigId
      )
        throw new Error('role_unavailable');
      role = await resolveTurnRole(
        {
          workspaceId: state.workspace,
          roleId: args.agentRoleId,
          userId: args.userId!,
          machineId: args.machineId,
          agentConfigId: args.agentConfigId,
        },
        state.getGrant,
        AbortSignal.any([state.controller.signal, AbortSignal.timeout(30000)]),
      );
      if (sessions.get(state.id) !== state || !state.ready)
        throw new Error('session_not_ready');
      const applied = roleRunConfigApplied(role.runConfig, {
        modelId:
          args.modelId === null ? null : (args.modelId ?? previous.modelId),
        modeId: args.modeId ?? previous.modeId,
        configOptionValues,
      });
      if (!applied) throw new Error('role_changed');
    }
    const pendingQueue = (state.doc.toJSON().mq ?? []) as any[];
    const mcpServerIds = await selectMcp(
      pendingQueue.findLast((item) =>
        Array.isArray(item.acpSessionConfig?.mcpServerIds),
      )?.acpSessionConfig.mcpServerIds ?? previous.mcpServerIds,
    );
    if (sessions.get(state.id) !== state || !state.ready)
      throw new Error('session_not_ready');
    const inputConfig = {
      cliType: args.cliType,
      agentType: args.agentType,
      // Web `buildAgentPrompt`: the Role's instruction, then the task. The visible
      // input stays the user's own text.
      prompt: [started ? '' : (role?.promptPrefix ?? ''), text]
        .filter((part) => part.trim())
        .join('\n\n'),
      inputBlocks: [
        ...(text
          ? [{ type: 'text', text, ...(spans?.length ? { spans } : {}) }]
          : []),
        ...attachments,
      ],
      // An explicit pick wins; otherwise the turn inherits what the session
      // already used, and an unset value leaves the machine on its default.
      modeId: args.modeId ?? previous.modeId,
      modelId:
        args.modelId === null ? undefined : (args.modelId ?? previous.modelId),
      configOptionValues: Object.keys(configOptionValues).length
        ? configOptionValues
        : undefined,
      mcpServerIds,
      taskToolsEnabled: previous.taskToolsEnabled ?? false,
      agentRoleId: role ? role.id : previous.agentRoleId,
      agentRoleRevision: role ? role.revision : previous.agentRoleRevision,
      ...(role?.runConfig.memory ? { memory: role.runConfig.memory } : {}),
      ...(role
        ? {
            agentRoleSnapshot: {
              id: role.id,
              revision: role.revision,
              name: role.name,
              emoji: role.emoji,
            },
          }
        : {}),
      resume: args.resume,
    };
    if (args.agentRoleId === null) {
      // An explicit None: the conversation no longer runs as its Role.
      inputConfig.agentRoleId = null;
      inputConfig.agentRoleRevision = undefined;
    } else if (!role && previous.agentRoleId) {
      const previousOptions = previous.configOptionValues ?? {};
      const changed =
        ['cliType', 'agentType', 'modelId', 'modeId'].some(
          (key) =>
            inputConfig[key as keyof typeof inputConfig] !== previous[key],
        ) ||
        JSON.stringify(inputConfig.mcpServerIds) !==
          JSON.stringify(previous.mcpServerIds ?? []) ||
        Object.keys(configOptionValues).length !==
          Object.keys(previousOptions).length ||
        Object.entries(configOptionValues).some(
          ([key, value]) => previousOptions[key] !== value,
        );
      if (changed) {
        // A changed run configuration no longer represents the frozen Role.
        inputConfig.agentRoleId = null;
        inputConfig.agentRoleRevision = undefined;
      }
    }
    const raw = state.doc.toJSON();
    const history = (raw.history ?? []) as any[];
    const lastUser = history.findLastIndex((entry) => entry.role === 'user');
    // Re-evaluate after attachment upload and mention expansion. A completed
    // target must follow the ordinary dispatch/queue path, never orphan a guide.
    const guide =
      args.guide === true
        ? history.findLast(
            (entry) => entry.role === 'assistant' && !entry.finished,
          )
        : undefined;
    const queued =
      !guide &&
      (args.queue === true ||
        (raw.mq as any[] | undefined)?.length ||
        history.some(
          (entry) => entry.role === 'assistant' && !entry.finished,
        ) ||
        (lastUser >= 0 &&
          history[lastUser].status === 'pending' &&
          !history
            .slice(lastUser + 1)
            .some((entry) => entry.role === 'assistant')));
    if (guide) {
      state.steerReceipts ??= new Map();
      state.steerReceipts.set(id, { targetId: guide.id, state: 'confirming' });
    }
    const before = state.doc.version();
    writeStarted = true;
    if (guide)
      state.doc.getMap('lodySteerLinks').set(id, {
        targetId: guide.id,
        mode: 'native',
      });
    if (queued) {
      // OSS consumes the shared movable queue, then creates its history turn.
      const item = state.doc.getMovableList('mq').pushContainer(new LoroMap());
      for (const [key, value] of Object.entries({
        task: text,
        userId: args.userId,
        userTurnId: id,
        timestamp,
      }))
        item.set(key, value);
      const config = item.setContainer('acpSessionConfig', new LoroMap());
      for (const [key, value] of Object.entries({
        ...inputConfig,
        chainDepth: 0,
      }))
        if (value !== undefined) config.set(key, value);
      state.doc.commit();
    } else {
      appendUserTurn(
        state.doc,
        id,
        text,
        args.userId,
        guide ? { ...inputConfig, _lodyDeliveryKind: 'steer' } : inputConfig,
        timestamp,
        guide ? 'pending_apply' : 'pending',
      );
    }
    const result = await state.client.append({
      part: {
        contentType: 'application/octet-stream',
        body: encodeFrame(state.doc.export({ mode: 'update', from: before })),
      },
    });
    if (!result.ok) throw new Error(result.result.code);
    uploaded = true;
    if (queued) {
      // The queue is durable before its catalog wake-up watermark is published.
      await state.markDispatch(state.id, id, true);
      scheduleEmit(state, 'live');
      return { id, state: 'queued' };
    }
    if (guide) {
      // History is durable; receipt tracking belongs to this message, not the
      // session-wide write lock. A later guide can be persisted while RPC waits.
      void steerTurn(state, args.machineId, {
        sessionId: state.id,
        expectedTurnId: guide.id,
        userTurnId: id,
        userId: args.userId,
        timestamp,
        inputConfig,
      })
        .catch(() => ({ state: 'not_applied' }))
        .then((result) => {
          if (args.backgroundTaskId)
            state.emit({
              type: 'sessionCache',
              sessionId: state.id,
              backgroundWork: {
                id: args.backgroundTaskId,
                state: result.state === 'applied' ? 'completed' : 'failed',
              },
            });
        });
      return { id, state: 'uploaded', awaitingGuide: true };
    }
    if (state.backgroundWork) {
      state.emit({
        type: 'sessionCache',
        sessionId: state.id,
        backgroundWork: { id: state.backgroundWork.id, state: 'failed' },
      });
    }
    state.backgroundWork = args.backgroundTaskId
      ? { id: args.backgroundTaskId, turnId: id }
      : undefined;
    await state.markDispatch(state.id, id);
    if (sessions.get(state.id) !== state) throw new Error('runtime_replaced');
    scheduleEmit(state, 'live');
    const replyTo = `${state.workspace}:rpc:res:${args.machineId}:${crypto.randomUUID()}`;
    const responseClient = await clientFor(replyTo, state.getGrant);
    const created = await responseClient.create({
      contentType: 'application/json',
      ttlSeconds: 300,
    });
    if (!created.ok) throw new Error(created.result.code);
    const requestId = crypto.randomUUID(),
      now = Date.now();
    const requestClient = await clientFor(
      `${state.workspace}:rpc:req:${args.machineId}`,
      state.getGrant,
    );
    const dispatched = await requestClient.append({
      part: {
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: requestId,
          rpcVersion: '1',
          workspaceId: state.workspace,
          machineId: args.machineId,
          replyTo,
          sentAt: now,
          expiresAt: now + 15000,
          method: 'session/dispatch-turn',
          params: {
            sessionId: state.id,
            userTurnId: id,
            userId: args.userId,
            timestamp,
            inputConfig,
          },
        }),
      },
    });
    if (!dispatched.ok) throw new Error(dispatched.result.code);
    const signal = AbortSignal.any([
      state.controller.signal,
      AbortSignal.timeout(18000),
    ]);
    let offset = '-1';
    while (!signal.aborted) {
      const read = await responseClient.readOnce({
        offset,
        live: 'long-poll',
        signal,
      });
      if (!read.ok) throw new Error(read.result.code);
      offset = read.result.nextOffset;
      if (!read.result.payload) continue;
      const parsed = JSON.parse(
        new TextDecoder().decode(read.result.payload.body),
      );
      for (const reply of Array.isArray(parsed) ? parsed : [parsed]) {
        if (reply.id !== requestId) continue;
        if (!reply.result?.accepted)
          throw new Error(
            reply.error?.message ??
              reply.result?.error ??
              reply.result?.disposition ??
              'dispatch_rejected',
          );
        return { id, state: 'accepted' };
      }
    }
    throw new Error('ack_timeout');
  } catch (error) {
    // No automatic write replay: a lost HTTP ACK may still mean a durable write.
    let delivery: 'not_sent' | 'unknown' | 'uploaded' = 'not_sent';
    if (writeStarted) delivery = 'unknown';
    if (uploaded) delivery = 'uploaded';
    return {
      id,
      state: delivery,
      reason: error instanceof Error ? error.message : 'send_failed',
    };
  } finally {
    state.sending = false;
    state.sendingId = undefined;
  }
}

export async function controlTurn(args: {
  action: 'stop' | 'steer';
  sessionId: string;
  machineId: string;
  turnId: string;
  messageId?: string;
  interrupt?: boolean;
}): Promise<ControlTurnResult> {
  const state = active;
  if (!state || state.id !== args.sessionId || !state.ready || state.sending)
    throw new Error('session_not_ready');
  if (
    !['stop', 'steer'].includes(args.action) ||
    typeof args.machineId !== 'string' ||
    !args.machineId.trim() ||
    typeof args.turnId !== 'string' ||
    !args.turnId.trim()
  )
    throw new Error('invalid_control');
  const history = state.doc.getList('history');
  const entries = history.toJSON() as any[];
  if (
    !entries.some(
      (entry) =>
        entry.id === args.turnId &&
        entry.role === 'assistant' &&
        !entry.finished,
    )
  )
    throw new Error('stale_turn');
  state.sending = true;
  try {
    let params: Record<string, unknown> = {
      sessionId: state.id,
      turnId: args.turnId,
    };
    if (args.action === 'steer') {
      if (typeof args.messageId !== 'string' || !args.messageId.trim())
        throw new Error('invalid_message');
      const queue = state.doc.getMovableList('mq');
      const index = (queue.toJSON() as any[]).findIndex(
        (item) => item.userTurnId === args.messageId,
      );
      const entry = entries.find((item) => item.id === args.messageId);
      if (
        entry &&
        (entry.role !== 'user' ||
          entry.status !== 'pending' ||
          entry.inputConfig?._lodyDeliveryKind !== 'steer' ||
          entries.some(
            (item) =>
              item.role === 'assistant' && item.userTurnId === args.messageId,
          ))
      )
        throw new Error('message_not_queued');
      const item = index >= 0 ? (queue.toJSON() as any[])[index] : undefined;
      const config = entry?.inputConfig ?? item?.acpSessionConfig;
      const userId = entry?.userId ?? item?.userId;
      const timestamp = entry?.timestamp ?? item?.timestamp;
      if (
        !config ||
        typeof config !== 'object' ||
        Array.isArray(config) ||
        typeof userId !== 'string' ||
        !userId ||
        typeof timestamp !== 'string' ||
        !timestamp
      )
        throw new Error('message_not_queued');
      if (args.interrupt && (index !== 0 || entry))
        throw new Error('message_not_first');
      state.steerReceipts ??= new Map();
      state.steerReceipts.set(args.messageId, {
        targetId: args.turnId,
        state: 'confirming',
      });
      const before = state.doc.version();
      state.doc.getMap('lodySteerLinks').set(args.messageId, {
        targetId: args.turnId,
        mode: args.interrupt ? 'interrupt' : 'native',
      });
      if (args.interrupt) {
        // Cancellation resumes the existing FIFO queue. Persist the exact edge
        // before cancellation; do not move/replay the machine-owned queue.
        const queued = queue.get(index);
        if (!(queued instanceof LoroMap)) throw new Error('invalid_queue');
        const queuedConfig = queued.get('acpSessionConfig');
        if (!(queuedConfig instanceof LoroMap))
          throw new Error('invalid_queue');
        queuedConfig.set('_lodyDeliveryKind', 'steer');
        queuedConfig.set('_lodySteerTarget', args.turnId);
        queuedConfig.set('_lodySteerMode', 'interrupt');
        state.doc.commit();
        scheduleEmit(state, state.status);
        const uploaded = await state.client.append({
          part: {
            contentType: 'application/octet-stream',
            body: encodeFrame(
              state.doc.export({ mode: 'update', from: before }),
            ),
          },
        });
        if (!uploaded.ok) throw new Error('steer_unconfirmed');
        const reply = await machineRpc(
          state.workspace,
          args.machineId,
          'session/cancel',
          { sessionId: state.id, turnId: args.turnId },
          state.getGrant,
          AbortSignal.any([
            state.controller.signal,
            AbortSignal.timeout(35000),
          ]),
        );
        if (
          reply.error ||
          (reply.result as { success?: boolean })?.success !== true
        )
          throw new Error('steer_unconfirmed');
        return { state: 'applied' };
      }
      // Move the same id atomically. pending_apply is durable intent, not delivery.
      // A lost append/RPC ACK must never trigger an automatic replay.
      if (!entry) {
        appendUserTurn(
          state.doc,
          args.messageId,
          item.task,
          userId,
          { ...config, _lodyDeliveryKind: 'steer' },
          timestamp,
          'pending_apply',
        );
      } else {
        const pending = history.get(entries.indexOf(entry));
        if (!(pending instanceof LoroMap)) throw new Error('invalid_history');
        pending.set('status', 'pending_apply');
        pending.set('read', false);
      }
      if (index >= 0) queue.delete(index, 1);
      state.doc.commit();
      const uploaded = await state.client.append({
        part: {
          contentType: 'application/octet-stream',
          body: encodeFrame(state.doc.export({ mode: 'update', from: before })),
        },
      });
      scheduleEmit(state, state.status);
      if (!uploaded.ok) throw new Error('steer_unconfirmed');
      params = {
        sessionId: state.id,
        expectedTurnId: args.turnId,
        userTurnId: args.messageId,
        userId,
        timestamp,
        inputConfig: config,
      };
      // Release the write lock in finally while this message awaits its receipt.
      return steerTurn(state, args.machineId, params);
    }
    const reply = await machineRpc(
      state.workspace,
      args.machineId,
      'session/cancel',
      params,
      state.getGrant,
      AbortSignal.any([state.controller.signal, AbortSignal.timeout(35000)]),
    );
    if (reply.error) throw new Error(reply.error.message ?? 'control_failed');
    const result = reply.result as
      { success?: boolean; error?: string } | undefined;
    if (result?.success !== true)
      throw new Error(result?.error ?? 'stop_failed');
    return { state: 'stopped' };
  } catch (error) {
    if (
      args.action === 'steer' &&
      args.messageId &&
      state.steerReceipts?.has(args.messageId)
    ) {
      state.steerReceipts?.set(args.messageId, {
        targetId: args.turnId,
        state: 'unknown',
      });
    }
    throw error;
  } finally {
    state.sending = false;
    scheduleEmit(state, state.status);
  }
}

async function steerTurn(
  state: SessionState,
  machineId: string,
  params: Record<string, unknown>,
): Promise<ControlTurnResult> {
  state.steerReceipts ??= new Map();
  const record = (delivery: SteerReceipt['state']) => {
    state.steerReceipts!.set(String(params.userTurnId), {
      targetId: String(params.expectedTurnId),
      state: delivery,
    });
    scheduleEmit(state, state.status);
  };
  record('confirming');
  const reply = await machineRpc(
    state.workspace,
    machineId,
    'session/steer',
    params,
    state.getGrant,
    AbortSignal.any([state.controller.signal, AbortSignal.timeout(35000)]),
  ).catch((error: unknown): RpcReply => ({
    error: {
      message: error instanceof Error ? error.message : 'control_failed',
    },
  }));
  if (reply.error) {
    record('unknown');
    return { state: 'not_applied', reason: reply.error.message };
  }
  const result = reply.result as
    { applied?: boolean; disposition?: string } | undefined;
  if (result?.applied !== true) {
    record('unknown');
    return { state: 'not_applied', reason: result?.disposition ?? 'unknown' };
  }
  record('accepted');
  const history = state.doc.getList('history');
  const before = state.doc.version();
  for (let i = 0; i < history.length; i++) {
    const entry = history.get(i);
    if (
      entry instanceof LoroMap &&
      entry.get('id') === params.userTurnId &&
      entry.get('status') === 'pending_apply'
    ) {
      entry.set('status', 'processing');
      entry.set('read', true);
    }
  }
  state.doc.commit();
  scheduleEmit(state, state.status);
  // Delivery is confirmed even if this redundant display-status append fails.
  await state.client
    .append({
      part: {
        contentType: 'application/octet-stream',
        body: encodeFrame(state.doc.export({ mode: 'update', from: before })),
      },
    })
    .catch(() => {});
  return { state: 'applied' };
}

export function docSnapshot() {
  return active?.doc.toJSON();
}

export async function editSession(
  args: {
    action: 'read' | 'send';
    sessionId: string;
    expectedUserTurnId: string;
    backgroundTaskId?: string;
    id?: string;
    text?: string;
    retainedIds?: string[];
    attachmentBlocks?: Record<string, any>[];
    userId: string;
    billingEntitlement?: BillingEntitlement | null;
  },
  meta: Record<string, any>,
  capability?: Record<string, any>,
): Promise<EditSessionResult> {
  const state = sessions.get(args.sessionId);
  if (!state?.ready || state.sending)
    return { state: 'not_sent', reason: 'session_not_ready' };
  const history = state.doc.getList('history').toJSON() as Record<
    string,
    any
  >[];
  if (args.id && history.some((entry) => entry.id === args.id))
    return { state: 'accepted', id: args.id };
  const turn = editableUserTurn(history, meta, capability);
  if (!turn || turn.id !== args.expectedUserTurnId)
    return { state: 'not_sent', reason: 'message_no_longer_editable' };
  if (args.action === 'read')
    return {
      state: 'ready',
      id: turn.id,
      text: (turn.items ?? [])
        .filter((item: any) => item.type === 'text')
        .map((item: any) => item.text ?? '')
        .join('\n\n'),
      attachments: editAttachments(turn),
    };
  if (
    !args.id ||
    args.id === turn.id ||
    !args.userId ||
    typeof args.text !== 'string'
  )
    return { state: 'not_sent', reason: 'invalid_message' };
  const quota = checkTurnQuota(args);
  if (quota.state === 'not_sent') return quota;
  let inputConfig;
  try {
    inputConfig = replacementInput(
      turn,
      args.text,
      args.retainedIds ?? [],
      args.attachmentBlocks ?? [],
    );
  } catch {
    return { state: 'not_sent', reason: 'invalid_message' };
  }
  state.sending = true;
  try {
    const response = await machineRpc(
      state.workspace,
      meta.machineId,
      'session/edit-and-resend',
      {
        sessionId: args.sessionId,
        expectedUserTurnId: turn.id,
        replacementUserTurnId: args.id,
        requestedByUserId: args.userId,
        timestamp: new Date().toISOString(),
        inputConfig,
      },
      state.getGrant,
      AbortSignal.any([state.controller.signal, AbortSignal.timeout(120000)]),
    );
    if (response.error)
      return { state: 'unknown', reason: response.error.message };
    const result = response.result as
      { success?: boolean; error?: { message?: string } } | undefined;
    if (result?.success === true) {
      if (args.backgroundTaskId)
        state.backgroundWork = { id: args.backgroundTaskId, turnId: args.id };
      return { state: 'accepted', id: args.id };
    }
    if (result?.success === false)
      return {
        state: 'not_sent',
        reason: result.error?.message ?? 'edit_failed',
      };
    return { state: 'unknown' };
  } catch {
    return { state: 'unknown' };
  } finally {
    state.sending = false;
    scheduleEmit(state, state.status);
  }
}
function scalar(value: unknown) {
  return value instanceof LoroText ? value.toString() : value;
}
function locateItem(entryId: string, itemId: string) {
  const state = active;
  if (!state) return undefined;
  const history = state.doc.getList('history');
  for (let i = 0; i < history.length; i++) {
    const entry = history.get(i);
    if (!(entry instanceof LoroMap) || entry.get('id') !== entryId) continue;
    const items = entry.get('items');
    if (!(items instanceof LoroList)) return undefined;
    for (let j = 0; j < items.length; j++) {
      const item = items.get(j);
      if (!(item instanceof LoroMap)) continue;
      // Desktop writes toolCallId as LoroText; the projection reads it via toJSON.
      const callId = scalar(item.get('toolCallId'));
      const id =
        scalar(item.get('type')) === 'tool_call' && typeof callId === 'string'
          ? callId
          : identityAt(items, j);
      if (id === itemId) return item;
    }
    return undefined;
  }
  return undefined;
}
const DETAIL_LIMIT = 512 * 1024;
function locateRunItem(entryId: string, itemId: string) {
  let path: unknown;
  try {
    path = JSON.parse(itemId);
  } catch {
    return;
  }
  if (
    !Array.isArray(path) ||
    path.length !== 2 ||
    !path.every((id) => typeof id === 'string')
  )
    return;
  const parent: any = locateItem(entryId, path[0])?.toJSON();
  if (parent?.type !== 'subagent_task' || !Array.isArray(parent.run?.items))
    return;
  return parent.run.items.find((item: any, index: number) => {
    const id =
      item?.type === 'tool_call' && typeof item.toolCallId === 'string'
        ? item.toolCallId
        : `run:${index}`;
    return id === path[1];
  });
}
export async function itemDetail(args: {
  sessionId: string;
  entryId: string;
  itemId: string;
  cursor?: string;
}) {
  if (!active || active.id !== args.sessionId || !active.ready)
    throw new Error('session_not_ready');
  const raw: any =
    locateItem(args.entryId, args.itemId)?.toJSON() ??
    locateRunItem(args.entryId, args.itemId);
  if (!raw) throw new Error('item_not_found');
  const content: unknown[] = Array.isArray(raw.content) ? raw.content : [];
  const start = Math.max(0, Number(args.cursor ?? 0) || 0);
  const blocks: unknown[] = [];
  let size = 0;
  let next = content.length;
  for (let i = start; i < content.length; i++) {
    const bytes = JSON.stringify(content[i]).length;
    if (blocks.length && size + bytes > DETAIL_LIMIT) {
      next = i;
      break;
    }
    blocks.push(content[i]);
    size += bytes;
  }
  const truncated = next < content.length;
  return {
    itemId: args.itemId,
    rev: itemRev(active.doc, args.entryId, args.itemId),
    blocks,
    rawInput: raw.rawInput,
    rawOutput: raw.rawOutput,
    options: raw.permissionRequest?.options,
    outcome: raw.permissionRequest?.outcome,
    truncated,
    nextCursor: truncated ? String(next) : undefined,
  };
}
export async function respondPermission(args: {
  sessionId: string;
  entryId: string;
  itemId: string;
  requestId: string;
  optionId: string;
  answers?: unknown;
}) {
  const state = active;
  if (!state || state.id !== args.sessionId || !state.ready)
    throw new Error('session_not_ready');
  const item = locateItem(args.entryId, args.itemId);
  const request = item?.get('permissionRequest');
  const current: any =
    request instanceof LoroMap ? request.toJSON() : (request ?? undefined);
  if (!item || !current || current.requestId !== args.requestId)
    return { state: 'stale' as const };
  const options: any[] = Array.isArray(current.options) ? current.options : [];
  if (!options.some((o) => o?.optionId === args.optionId))
    throw new Error('invalid_option');
  const key = `${args.entryId}/${args.itemId}/${args.requestId}`;
  const meta = parseQuestionMeta(current._meta);
  const selected = options.find((o) => o?.optionId === args.optionId);
  const isReject = selected?.kind?.startsWith('reject');
  if (
    !meta &&
    (current.kind === 'ask_user_question' ||
      item.get('kind') === 'ask_user_question') &&
    !isReject
  )
    throw new Error('invalid_answers');
  let outcome: Record<string, unknown> = {
    outcome: 'selected',
    optionId: args.optionId,
  };
  if (meta && !isReject)
    outcome = questionOutcome(args.optionId, meta, args.answers);
  if (current.outcome != null) {
    if (!samePermissionOutcome(current.outcome, outcome))
      return { state: 'conflict' as const };
    if (!state.unsent.has(key)) return { state: 'accepted' as const };
  }
  const before = state.unsent.get(key)?.version ?? state.doc.version();
  if (current.outcome == null) {
    if (request instanceof LoroMap) request.set('outcome', outcome);
    else item.set('permissionRequest', { ...current, outcome });
    state.doc.commit();
  }
  // Register before awaiting: a thrown transport error also needs explicit retry.
  state.unsent.set(key, { version: before, outcome });
  const result = await state.client.append({
    part: {
      contentType: 'application/octet-stream',
      body: encodeFrame(state.doc.export({ mode: 'update', from: before })),
    },
  });
  if (!result.ok) {
    // A user-initiated retry re-exports from this version; nothing replays on its own.
    state.unsent.set(key, { version: before, outcome });
    throw new Error('upload_failed');
  }
  state.unsent.delete(key);
  if (active === state) scheduleEmit(state, 'live');
  return { state: 'accepted' as const };
}

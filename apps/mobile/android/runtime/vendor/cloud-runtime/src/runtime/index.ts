import { sessionQuotaProjection } from '../protocol/session-usage.ts';
import { Flock } from '@loro-dev/flock-wasm/base64';
import { StreamsClient } from '@loro-dev/streams-client';
import { decompress } from 'fzstd';
import type { Project } from '../models/catalog.ts';
import { keepRepos, projectRows } from '../protocol/catalog.ts';
import { mergeAgentQuotas } from '../protocol/agent-usage.ts';
import {
  reservedSessionIds,
  resumeAcceptedInputs,
  retainedSessionIds,
  setSessionTraceSink,
  setSessionUsageReader,
  refreshSessionUsage,
} from './session';
import { machineRpc } from './machine-rpc';
import { retrySessionRead } from './session-read';
import { providerRows } from './provider-settings';
import { decodeFrames, encodeFrame } from '../frames';
import { watchMachinePresence } from './machine-presence';
import { unknownPresence } from '../models/machines.ts';
import type {
  Grant,
  SessionRuntimeEvent,
  ShareRequestParams,
} from '../contract/methods.ts';
import { ContractError, createChannel } from './channel.ts';
import type { RuntimeContext, RuntimeState } from './handlers/context.ts';
import { registerContent } from './handlers/content.ts';
import { registerDebug } from './handlers/debug.ts';
import { registerLifecycle } from './handlers/lifecycle.ts';
import { registerMentions } from './handlers/mentions.ts';
import { registerProjects } from './handlers/projects.ts';
import { registerSessions } from './handlers/sessions.ts';
import { registerSettings } from './handlers/settings.ts';
import { registerSchedules } from './handlers/schedules.ts';
import { registerProposals } from './handlers/proposals.ts';
import { registerSharing } from './handlers/sharing.ts';
const host = (globalThis as any).webkit.messageHandlers.dataRuntime;
const send = (message: object) => host.postMessage(message);
const channel = createChannel(
  (envelope) => send({ type: 'envelope', envelope }),
  {
    onDroppedKeys: (method, paths) =>
      channel.emit('diagnostic', {
        stage: `contract_dropped ${paths.join(' ')}`,
        stream: method,
      }),
  },
);
setSessionTraceSink((event) => channel.emit('sessionTrace', event));
function emitSession(event: SessionRuntimeEvent) {
  if (event.type === 'session') {
    const { type, ...payload } = event;
    channel.emit(type, payload);
  } else if (event.type === 'sessionCache') {
    const { type, ...payload } = event;
    channel.emit(type, payload);
  } else {
    const { type, ...payload } = event;
    channel.emit(type, payload);
  }
}
const publishSubscriptions = () =>
  channel.emit('sessionSubscriptions', {
    ids: retainedSessionIds(),
    reserved: reservedSessionIds(),
  });
let grant: Grant | undefined,
  expiresAt = 0;
let grantPending: Promise<Grant> | undefined;
async function getGrant() {
  if (grant && Date.now() < expiresAt) return grant;
  grantPending ??= channel
    .request('grant', {})
    .then((value) => {
      grant = value;
      expiresAt = Date.now() + Math.max(1, value.expiresIn - 30) * 1000;
      return value;
    })
    .finally(() => {
      grantPending = undefined;
    });
  return grantPending;
}
const delay = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('cancelled'));
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(new Error('cancelled'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
const state: RuntimeState = {
  workspace: '',
  userId: '',
  metaReplica: undefined,
  presence: unknownPresence,
  knownProjects: [],
  machineReplicas: new Map(),
  catalogs: new Map(),
  unhealthy: new Set(),
};
const { machineReplicas, catalogs, unhealthy } = state;
let stopPresence: (() => void) | undefined;
function startPresence() {
  stopPresence?.();
  stopPresence = watchMachinePresence(state.workspace, getGrant, (value) => {
    state.presence = value;
    channel.emit('machinePresence', value);
  });
}

async function markDispatch(sessionId: string, turnId: string, queued = false) {
  if (!state.metaReplica) throw new Error('metadata_not_ready');
  const { flock, client } = state.metaReplica;
  const version = flock.version();
  if (queued) {
    const key = ['m', `session-${sessionId}`, 'messageQueueUpdatedAt'];
    const previous = flock.get(key);
    flock.set(
      key,
      Math.max(
        Date.now(),
        typeof previous === 'number' && Number.isFinite(previous)
          ? previous + 1
          : 0,
      ),
    );
  } else {
    flock.set(['m', `session-${sessionId}`, 'latestUserMsgId'], turnId);
    flock.set(
      ['m', `session-${sessionId}`, 'lastMissingHistoryUserMsgId'],
      undefined,
    );
  }
  flock.commit();
  const result = await client.append({
    part: {
      contentType: 'application/octet-stream',
      body: encodeFrame(
        new TextEncoder().encode(JSON.stringify(flock.exportJson(version))),
      ),
    },
  });
  if (!result.ok) throw new Error(result.result.code);
}
const watchers = new Map<string, AbortController>();
const broker = async (operation: string, args: object) => {
  try {
    const { value } = await channel.request('shareRequest', {
      workspaceId: state.workspace,
      operation,
      args,
    } as ShareRequestParams);
    return value;
  } catch (error) {
    throw new Error(
      error instanceof ContractError && error.code === 'timeout'
        ? 'share_request_timeout'
        : 'share_request_failed',
    );
  }
};
const gitRepos = new Map<string, string>();
const gitStateAsked = new Set<string>();
let gitStateQueue = Promise.resolve();
// ponytail: one ask per project per runtime; an offline machine keeps its last repo through the saved catalog until restart.
function askGitState(project: Project) {
  const localProjectId = project.id.split(':local:')[1];
  if (
    project.repoFullName ||
    !localProjectId ||
    !state.userId ||
    gitStateAsked.has(project.id)
  )
    return;
  gitStateAsked.add(project.id);
  gitStateQueue = gitStateQueue.then(() =>
    machineRpc(
      state.workspace,
      project.machineId,
      'local-project/git-state',
      { localProjectId, requestedByUserId: state.userId },
      getGrant,
      AbortSignal.timeout(20000),
    ).then(
      (reply) => {
        const result = reply.result as
          | {
              success?: boolean;
              state?: { git?: boolean; githubRepoFullName?: unknown };
            }
          | undefined;
        const repo =
          result?.success && result.state?.git
            ? String(result.state.githubRepoFullName ?? '').trim()
            : '';
        if (!repo) return;
        gitRepos.set(project.id, repo);
        publish();
      },
      () => {},
    ),
  );
}
setSessionUsageReader((sessionId, modelId) => {
  const meta = catalogs.get('meta');
  const session = meta?.sessions.find((s) => s.id === sessionId);
  const machine =
    session && catalogs.get(session.machineId)?.agentUsage?.[session.machineId];
  return sessionQuotaProjection(
    session,
    session
      ? {
          configs: machine?.configs ?? [],
          quotas: mergeAgentQuotas(
            meta?.agentUsage?.[session.machineId]?.quotas ?? [],
            machine?.quotas ?? [],
          ),
        }
      : undefined,
    modelId,
  );
});
let revision = 0;
let lastPublished = '';
function publish() {
  const meta = catalogs.get('meta');
  if (!meta) return;
  const expected = new Set(['meta', ...meta.machineIds]);
  for (const [id, controller] of watchers)
    if (!expected.has(id)) {
      controller.abort();
      watchers.delete(id);
      catalogs.delete(id);
      machineReplicas.delete(id);
      unhealthy.delete(id);
    }
  for (const machine of meta.machineIds)
    if (!watchers.has(machine)) watch(machine);
  refreshSessionUsage();
  channel.emit('creationOptionsChanged', {});
  if (unhealthy.size || meta.machineIds.some((id) => !catalogs.has(id))) return;
  const projects = new Map(meta.projects.map((p) => [p.id, p]));
  for (const id of meta.machineIds)
    for (const p of catalogs.get(id)!.projects)
      projects.set(p.id, { ...projects.get(p.id), ...p });
  for (const [id, p] of projects) {
    const repo = gitRepos.get(id);
    if (repo && !p.repoFullName) projects.set(id, { ...p, repoFullName: repo });
    else askGitState(p);
  }
  const merged = keepRepos(
    {
      ...meta,
      agentUsage: Object.fromEntries(
        meta.machineIds.map((id) => {
          const usage = catalogs.get(id)?.agentUsage?.[id];
          return [
            id,
            {
              configs: usage?.configs ?? [],
              quotas: mergeAgentQuotas(
                meta.agentUsage?.[id]?.quotas ?? [],
                usage?.quotas ?? [],
              ),
            },
          ];
        }),
      ),
      projects: [...projects.values()].sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
      sessions: [...meta.sessions].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      ),
    },
    { projects: state.knownProjects },
  );
  state.knownProjects = merged.projects;
  const catalog = JSON.stringify(merged);
  if (catalog !== lastPublished) {
    lastPublished = catalog;
    channel.emit('catalog', { catalog, revision: ++revision });
  }
  channel.emit('synced', { revision, streams: watchers.size });
}
function apply(flock: Flock, bytes: Uint8Array) {
  for (const frame of decodeFrames(bytes))
    flock.importJson(JSON.parse(new TextDecoder().decode(frame)));
}
function watch(mode: string) {
  const controller = new AbortController();
  watchers.set(mode, controller);
  const { signal } = controller;
  void (async () => {
    let failures = 0;
    let providerSignature = '';
    while (!signal.aborted) {
      try {
        const authorization = await getGrant();
        if (signal.aborted) return;
        const stream =
          mode === 'meta'
            ? `${state.workspace}:meta`
            : `${state.workspace}:mf:${mode}`;
        const client = new StreamsClient({
          url: `${authorization.gatewayBaseUrl.replace(/\/$/, '')}/ds/lody/${encodeURIComponent(stream)}`,
          auth: async () => (await getGrant()).token,
          retry: { maxAttempts: 1 },
          timeout: { connectTimeoutMs: 15000, pollTimeoutMs: 35000 },
        });
        channel.emit('diagnostic', { stage: 'bootstrap', stream: mode });
        const initial = await client.bootstrap({ signal });
        channel.emit('diagnostic', {
          stage: initial.ok ? 'bootstrap_ok' : initial.result.code,
          stream: mode,
        });
        if (!initial.ok) {
          if (initial.result.code === 'not_found' && mode !== 'meta') {
            unhealthy.delete(mode);
            catalogs.set(mode, { projects: [], sessions: [], machineIds: [] });
            publish();
            await delay(30000, signal);
            continue;
          }
          throw new Error(initial.result.code);
        }
        const flock = new Flock(`lody-ios-${crypto.randomUUID()}`);
        const data = initial.result;
        let size = 0;
        if (data.snapshotOffset !== '-1' && data.snapshot) {
          const bytes = data.snapshot.body;
          size += bytes.length;
          if (size > 16 * 1024 * 1024) throw new Error('catalog_limit');
          flock.importFile(
            bytes[0] === 0x28 &&
              bytes[1] === 0xb5 &&
              bytes[2] === 0x2f &&
              bytes[3] === 0xfd
              ? decompress(bytes)
              : bytes,
          );
        }
        for (const part of data.updates) {
          size += part.body.length;
          if (size > 16 * 1024 * 1024) throw new Error('catalog_limit');
          apply(flock, part.body);
        }
        let offset = data.nextOffset,
          cursor = data.cursor,
          upToDate = data.upToDate;
        let pages = 0;
        while (!signal.aborted) {
          if (upToDate) {
            if (mode === 'meta') {
              const first = !state.metaReplica;
              // Keep the replica's identity across polls: in-flight calls
              // compare it to detect a reconnect, not a routine update.
              if (state.metaReplica?.flock !== flock)
                state.metaReplica = { flock, client };
              if (first) resumeAcceptedInputs();
            } else machineReplicas.set(mode, flock);
            unhealthy.delete(mode);
            catalogs.set(mode, projectRows(flock.scan(), mode));
            publish();
            if (mode !== 'meta') {
              const nextSignature = JSON.stringify(
                providerRows(flock, mode, false),
              );
              if (nextSignature !== providerSignature) {
                providerSignature = nextSignature;
                channel.emit('agentProvidersChanged', { machineId: mode });
              }
            }
            failures = 0;
            pages = 0;
          }
          // A failed read has not imported bytes or advanced the cursor. Keep
          // that verified replica through transport loss and host suspension.
          // Protocol/cursor failures still leave this loop for a fresh bootstrap.
          const response = await retrySessionRead(
            signal,
            async () => {
              const result = await client.readOnce({
                offset,
                cursor,
                signal,
                ...(upToDate ? { live: 'long-poll' as const } : {}),
              });
              if (!result.ok) {
                const error = result.result;
                const aborted =
                  error.code === 'unknown' &&
                  (error.cause instanceof Error || error.cause instanceof DOMException) &&
                  error.cause.name === 'AbortError';
                const suspended = aborted && error.cause.message === 'runtime_suspended';
                if (
                  [
                    'network_error',
                    'timeout',
                    'unauthorized',
                    'forbidden',
                    'rate_limited',
                  ].includes(error.code) ||
                  aborted ||
                  (error.code === 'unknown' && (error.status ?? 0) >= 500)
                )
                  throw new Error(suspended ? 'runtime_suspended' : error.code);
              }
              return result;
            },
            (error) => {
              unhealthy.add(mode);
              channel.emit('creationOptionsChanged', {});
              channel.emit('syncError', {
                reason: 'network_or_auth',
                stream: mode,
              });
              if (!(error instanceof Error && error.message === 'runtime_suspended'))
                grant = undefined;
            }
          );
          if (!response.ok) throw new Error(response.result.code);
          const next = response.result;
          if (signal.aborted) return;
          if (next.payload) {
            size += next.payload.body.length;
            if (size > 16 * 1024 * 1024) throw new Error('catalog_limit');
            apply(flock, next.payload.body);
          }
          if (next.nextOffset === offset && !next.upToDate)
            throw new Error('stalled_cursor');
          if (++pages > 100 && !next.upToDate) throw new Error('catalog_limit');
          offset = next.nextOffset;
          cursor = next.cursor;
          upToDate = next.upToDate;
          if (next.closed) throw new Error('stream_closed');
          // Empty responses may arrive immediately; avoid a hot polling loop.
          if (!next.payload?.body.length && upToDate) await delay(1000, signal);
        }
      } catch (error) {
        if (signal.aborted) return;
        if (mode === 'meta') state.metaReplica = undefined;
        else machineReplicas.delete(mode);
        unhealthy.add(mode);
        channel.emit('creationOptionsChanged', {});
        const reason = error instanceof Error ? error.message : 'sync_failed';
        channel.emit('syncError', {
          reason:
            (
              ['catalog_limit', 'stream_closed', 'stalled_cursor'] as const
            ).find((known) => known === reason) ?? 'network_or_auth',
          stream: mode,
        });
        grant = undefined;
        if (reason === 'catalog_limit') return;
        try {
          await delay(
            Math.min(30000, 2000 * 2 ** Math.min(failures++, 4)),
            signal,
          );
        } catch {
          return;
        }
      }
    }
  })();
}
const ctx: RuntimeContext = {
  channel,
  state,
  getGrant,
  broker,
  publish,
  publishSubscriptions,
  emitSession,
  markDispatch,
  watch,
  startPresence,
  stopPresence: () => {
    stopPresence?.();
    stopPresence = undefined;
  },
};
registerLifecycle(ctx);
registerSettings(ctx);
const getMentions = registerMentions(ctx);
registerProjects(ctx);
registerSchedules(ctx);
registerProposals(ctx);
registerSharing(ctx);
registerContent(ctx);
registerSessions(ctx, getMentions);
registerDebug(ctx);
Object.assign(globalThis, {
  dataRuntime: {
    receive(envelope: string) {
      channel.receive(envelope);
    },
  },
});
send({ type: 'ready' });

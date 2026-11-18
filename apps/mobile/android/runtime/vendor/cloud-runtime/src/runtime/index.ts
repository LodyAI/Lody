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
import { encodeFrame } from '../frames';
import {
  catalogImportCheckpoint,
  importCatalogUpdates,
  readCatalogRefresh,
  catalogBootstrapSlots,
} from './catalog-sync';
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
const acquireCatalogBootstrap = catalogBootstrapSlots(2);
let revision = 0;
let lastPublished = '';
let publishTimer: ReturnType<typeof setTimeout> | undefined;
function publish() {
  if (publishTimer !== undefined) return;
  // Read the current scope at flush time; never retain an old catalog payload.
  publishTimer = setTimeout(() => {
    publishTimer = undefined;
    publishNow();
  }, 16);
}
function publishNow() {
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
  if (unhealthy.has('meta')) return;
  const projects = new Map(meta.projects.map((p) => [p.id, p]));
  for (const id of meta.machineIds)
    for (const p of catalogs.get(id)?.projects ?? [])
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
function watch(mode: string) {
  const controller = new AbortController();
  watchers.set(mode, controller);
  const { signal } = controller;
  const reportError = (
    reason:
      'catalog_limit' | 'stream_closed' | 'stalled_cursor' | 'network_or_auth',
  ) => {
    // Native hosts interpret syncError as workspace unavailability. A machine
    // failure only removes that machine's readiness, not the meta directory.
    if (mode === 'meta') channel.emit('syncError', { reason, stream: mode });
    else
      channel.emit('diagnostic', {
        stage: `sync_error:${reason}`,
        stream: mode,
      });
  };
  void (async () => {
    let failures = 0;
    let providerSignature = '';
    let preparedBootstrap: Awaited<ReturnType<typeof readCatalogRefresh>>;
    while (!signal.aborted) {
      let caughtUp = false;
      let releaseBootstrap = () => {};
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
          // Keep writes within the native command budget; SDK 0.12+ defaults uploads to 60s.
          timeout: {
            connectTimeoutMs: 15000,
            uploadTimeoutMs: 15000,
            pollTimeoutMs: 35000,
          },
        });
        if (mode !== 'meta')
          releaseBootstrap = await acquireCatalogBootstrap(signal);
        const checkpoint = catalogImportCheckpoint(signal);
        channel.emit('diagnostic', { stage: 'bootstrap', stream: mode });
        const initial = preparedBootstrap
          ? { ok: true as const, result: preparedBootstrap }
          : await client.bootstrap({ signal });
        preparedBootstrap = undefined;
        channel.emit('diagnostic', {
          stage: initial.ok ? 'bootstrap_ok' : initial.result.code,
          stream: mode,
        });
        if (!initial.ok) {
          if (initial.result.code === 'not_found' && mode !== 'meta') {
            unhealthy.delete(mode);
            catalogs.set(mode, { projects: [], sessions: [], machineIds: [] });
            publish();
            releaseBootstrap();
            await delay(30000, signal);
            continue;
          }
          throw new Error(initial.result.code);
        }
        const flock = new Flock(`lody-ios-${crypto.randomUUID()}`);
        const data = initial.result;
        const snapshotBytes = data.snapshot?.body.length ?? 0;
        let size = 0;
        if (data.snapshotOffset !== '-1' && data.snapshot) {
          const bytes = data.snapshot.body;
          size += bytes.length;
          if (size > 16 * 1024 * 1024) throw new Error('catalog_limit');
          await checkpoint(true);
          flock.importFile(
            bytes[0] === 0x28 &&
              bytes[1] === 0xb5 &&
              bytes[2] === 0x2f &&
              bytes[3] === 0xfd
              ? decompress(bytes)
              : bytes,
          );
        }
        await checkpoint();
        for (const part of data.updates) {
          size += part.body.length;
          if (size > 16 * 1024 * 1024) throw new Error('catalog_limit');
          await importCatalogUpdates(flock, part.body, checkpoint);
        }
        let offset = data.nextOffset,
          cursor = data.cursor,
          upToDate = data.upToDate;
        let pages = 0;
        let checkedWindow = false;
        while (!signal.aborted) {
          if (upToDate) {
            caughtUp = true;
            if (mode === 'meta') {
              const first = !state.metaReplica;
              // Keep the replica's identity across polls: in-flight calls
              // compare it to detect a reconnect, not a routine update.
              if (state.metaReplica?.flock !== flock)
                state.metaReplica = { flock, client };
              if (first) resumeAcceptedInputs();
            } else machineReplicas.set(mode, flock);
            unhealthy.delete(mode);
            await checkpoint();
            const rows = flock.scan();
            catalogs.set(mode, projectRows(rows, mode));
            if (mode !== 'meta') {
              const nextSignature = JSON.stringify(
                providerRows(flock, mode, false, rows),
              );
              if (nextSignature !== providerSignature) {
                providerSignature = nextSignature;
                channel.emit('agentProvidersChanged', { machineId: mode });
              }
            }
            releaseBootstrap();
            publish();
            checkedWindow = false;
            failures = 0;
            pages = 0;
            // Bootstrap includes its snapshot. Each later live/catch-up window
            // gets a fresh budget, retained across transient read retries.
            size = 0;
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
                  (error.cause instanceof Error ||
                    error.cause instanceof DOMException) &&
                  error.cause.name === 'AbortError';
                const suspended =
                  aborted && error.cause.message === 'runtime_suspended';
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
              reportError('network_or_auth');
              if (!(
                error instanceof Error && error.message === 'runtime_suspended'
              ))
                grant = undefined;
            },
          );
          if (!response.ok) throw new Error(response.result.code);
          const next = response.result;
          if (signal.aborted) return;
          if (
            caughtUp &&
            !checkedWindow &&
            (!next.upToDate || (next.payload?.body.length ?? 0) >= 256 * 1024)
          ) {
            checkedWindow = true;
            const refreshed = await readCatalogRefresh(
              client,
              offset,
              snapshotBytes,
              16 * 1024 * 1024,
              signal,
            );
            if (refreshed) {
              preparedBootstrap = refreshed;
              throw new Error('catalog_rebootstrap');
            }
          }
          if (next.payload?.body.length || !next.upToDate) unhealthy.add(mode);
          if (next.payload) {
            size += next.payload.body.length;
            if (size > 16 * 1024 * 1024) throw new Error('catalog_limit');
            await importCatalogUpdates(flock, next.payload.body, checkpoint);
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
        releaseBootstrap();
        if (signal.aborted) return;
        if (mode === 'meta') state.metaReplica = undefined;
        else machineReplicas.delete(mode);
        unhealthy.add(mode);
        channel.emit('creationOptionsChanged', {});
        const reason = error instanceof Error ? error.message : 'sync_failed';
        if (
          reason === 'catalog_rebootstrap' ||
          (reason === 'catalog_limit' && caughtUp)
        ) {
          // An old replica can have an arbitrarily long backlog. Discard it
          // and try the server's compacted snapshot before declaring a limit.
          channel.emit('diagnostic', {
            stage: 'catalog_rebootstrap',
            stream: mode,
          });
          continue;
        }
        reportError(
          (['catalog_limit', 'stream_closed', 'stalled_cursor'] as const).find(
            (known) => known === reason,
          ) ?? 'network_or_auth',
        );
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
      } finally {
        releaseBootstrap();
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

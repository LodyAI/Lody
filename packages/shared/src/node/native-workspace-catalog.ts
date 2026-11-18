import { assertNativeFlockRewriteValue } from './native-flock-value';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { RepoRpcError, type RepoClient, type JsonValue } from '@loro-dev/loro-repo-client';
import { assertPublicMcpServer, publicMcpServer } from '../mcp-authentication';
import {
  WorkspaceCatalogError,
  assertWorkspaceCatalogBinding,
  projectWorkspaceCatalog,
  workspaceCatalogMutation,
  type WorkspaceCatalogBinding,
  type WorkspaceCatalogCommand,
  type WorkspaceCatalogCommands,
  type WorkspaceCatalogProjection,
  type WorkspaceCatalogReader,
  type WorkspaceCatalogRoleLookup,
} from '../workspace-catalog';
import {
  canManageAgentRole,
  canReadAgentRole,
  isSensitiveAgentRoleConfigOptionKey,
  normalizeAgentRole,
  serializeAgentRoleRow,
} from '../agent-role';
import {
  getWorkspaceFlockDocId,
  parseWorkspaceFlockRow,
  workspaceFlockKeys,
} from '../workspace-flock';
import {
  planAgentRoleSchemaReconciliation,
  type AgentRoleSchemaEvidence,
  type ReconcileAgentRoleSchemaCommand,
} from '../agent-role-schema-reconciliation';
import type { AgentRoleId } from '../ids';
import type { WorkspaceMcpServerMeta } from '../workspace-mcp';

const record = z.record(z.string(), z.unknown());
const scannedRows = z.array(z.object({ key: z.array(z.unknown()), value: z.unknown().optional() }));

/**
 * Private trusted-owner adapter. Never return this client, a raw row, or SDK
 * handle over renderer IPC. The whole wf room must be selected by its owner.
 */
export type NativeWorkspaceCatalogOptions = {
  readonly client: RepoClient;
  readonly namespace: string;
  readonly binding: WorkspaceCatalogBinding;
  /** A live grant from composition; request fields are not authorization. */
  readonly authorize: (
    operation: 'read' | 'write' | 'upload',
    command?: WorkspaceCatalogCommand
  ) => boolean;
  readonly authority?: { current(): boolean; subscribe(listener: () => void): () => void };
  readonly confirmUpload?: () => Promise<void>;
  /** Trusted composition grant for exact CLI IDs; never a renderer-selected mode. */
  readonly authorizeRoleLookup?: (id: AgentRoleId) => boolean;
  /** Resolve from owner-controlled fresh runtime evidence, never renderer schema claims. */
  readonly resolveRoleSchemaEvidence?: (
    command: ReconcileAgentRoleSchemaCommand
  ) => Promise<AgentRoleSchemaEvidence | undefined>;
};
export function createNativeWorkspaceCatalog(
  options: NativeWorkspaceCatalogOptions
): WorkspaceCatalogReader & WorkspaceCatalogCommands & WorkspaceCatalogRoleLookup {
  if (!options.binding.accountId) throw new Error('Native catalog requires an account binding');
  const { client, namespace } = options;
  const expected = Object.freeze({ ...options.binding });
  const room = { kind: 'flock' as const, id: getWorkspaceFlockDocId(expected.workspaceId) };
  const check = (
    binding: WorkspaceCatalogBinding,
    operation: 'read' | 'write' | 'upload',
    command?: WorkspaceCatalogCommand
  ) => {
    assertWorkspaceCatalogBinding(expected, binding);
    if (!options.authorize(operation, command)) throw new Error('Workspace catalog access denied');
  };
  const project = (rows: unknown): WorkspaceCatalogProjection => {
    const entries = scannedRows.parse(rows);
    const projection = projectWorkspaceCatalog({
      scan: (query) =>
        query?.prefix
          ? entries.filter((entry) =>
              query.prefix?.every((part, index) => entry.key[index] === part)
            )
          : entries,
    });
    return {
      ...projection,
      roles: projection.roles.filter((role) => canReadAgentRole(role, expected.accountId)),
    };
  };
  return {
    async readRole(binding, id) {
      check(binding, 'read');
      if (options.authorizeRoleLookup?.(id) !== true)
        throw new Error('Explicit Role lookup access denied');
      const stored = await client.flockGet(namespace, room, workspaceFlockKeys.agentRole(id));
      check(binding, 'read');
      if (options.authorizeRoleLookup?.(id) !== true)
        throw new Error('Explicit Role lookup access denied');
      const role = stored.found ? normalizeAgentRole(stored.value) : undefined;
      return role?.id === id ? role : undefined;
    },
    async read(binding) {
      check(binding, 'read');
      const snapshot = await client.flockScan(namespace, room);
      check(binding, 'read');
      return project(snapshot.entries);
    },
    async observe(binding, onUpdate, onError) {
      check(binding, 'read');
      let closed = false;
      let current: WorkspaceCatalogProjection | undefined;
      const publish = () => {
        if (closed || !current) return;
        try {
          check(binding, 'read');
          onUpdate({
            projection: current,
            synced: client.connectionState === 'connected' && options.authority?.current() === true,
          });
        } catch (error) {
          onError(error);
        }
      };
      const subscription = await client.flockSubscribe(namespace, room, {}, (value) => {
        if (closed) return;
        try {
          current = project(value);
          publish();
        } catch (error) {
          onError(error);
        }
      });
      let unlistenConnection = () => {};
      let unlistenAuthority: (() => void) | undefined;
      let released = false;
      let releasing: Promise<void> | undefined;
      let unconfirmedRelease: unknown;
      let releaseUnconfirmed = false;
      let unlistenReleaseProof: (() => void) | undefined;
      const close = (): Promise<void> => {
        closed = true;
        unlistenConnection();
        unlistenAuthority?.();
        if (released) return Promise.resolve();
        if (releaseUnconfirmed) {
          if (client.connectionState !== 'connected') {
            released = true;
            unlistenReleaseProof?.();
            return Promise.resolve();
          }
          return Promise.reject(unconfirmedRelease);
        }
        if (releasing) return releasing;
        const pending = Promise.resolve()
          .then(() => subscription.unsubscribe())
          .then(() => {
            released = true;
          })
          .catch((error) => {
            // 0.1.0 cancels/forgets its local handle BEFORE the unsubscribe RPC.
            // A rejected RPC followed by isClosed cannot be retried through that
            // handle: it would return a local no-op, not an engine receipt.
            if (subscription.isClosed) {
              releaseUnconfirmed = true;
              unconfirmedRelease = error;
              unlistenReleaseProof = client.onConnectionStateChange((state) => {
                if (state !== 'connected') {
                  released = true;
                  unlistenReleaseProof?.();
                }
              });
              if (client.connectionState !== 'connected') {
                released = true;
                unlistenReleaseProof();
              }
            }
            throw error;
          });
        releasing = pending;
        void pending.catch(() => {
          if (releasing === pending) releasing = undefined;
        });
        return pending;
      };
      try {
        check(binding, 'read');
        // 0.1.0 sets currentValue on first subscribe without invoking its listener.
        // Buffered updates, if any, have already advanced this same handle.
        if (!current) {
          current = project(subscription.currentValue);
          publish();
        }
        unlistenConnection = client.onConnectionStateChange((state) => {
          if (closed) return;
          if (state === 'closed')
            onError(
              new WorkspaceCatalogError(
                'restart_required',
                'Native catalog owner must be reacquired'
              )
            );
          else publish();
        });
        unlistenAuthority = options.authority?.subscribe(publish);
      } catch (error) {
        try {
          await close();
        } catch (cleanup) {
          throw new NativeCatalogAcquireCleanupError(error, cleanup, close);
        }
        throw error;
      }
      return { close };
    },

    async execute(binding, command, execution) {
      check(binding, 'write', command);
      if (execution?.signal?.aborted) return { changed: false };
      const mutation =
        command.kind === 'reconcile-role-schema'
          ? { key: workspaceFlockKeys.agentRole(command.expected.id), value: undefined }
          : workspaceCatalogMutation(command);
      for (let attempt = 0; ; attempt++) {
        check(binding, 'write', command);
        const stored = await client.flockGet(namespace, room, mutation.key);
        check(binding, 'write', command);
        if (execution?.signal?.aborted) return { changed: false };
        const raw = stored.found ? stored.value : undefined;
        const previous = raw === undefined ? undefined : parseWorkspaceFlockRow(mutation.key, raw);
        if (raw !== undefined && !previous) throw new Error('Unsupported workspace catalog row');
        if (command.kind === 'put-role' || command.kind === 'delete-role') {
          const role = raw === undefined ? undefined : normalizeAgentRole(raw);
          if (
            (role && !canManageAgentRole(role, expected.accountId)) ||
            (command.kind === 'put-role' && command.role.ownerUserId !== expected.accountId)
          )
            throw new Error('Workspace catalog access denied');
        }
        if (command.kind === 'put-project' || command.kind === 'delete-project') {
          const owner = record.safeParse(raw);
          if (
            (owner.success && owner.data.ownerUserId !== expected.accountId) ||
            (command.kind === 'put-project' && command.project.ownerUserId !== expected.accountId)
          )
            throw new Error('Workspace catalog access denied');
        }
        if ('expectedRevision' in command && command.expectedRevision !== undefined) {
          const revision = record.safeParse(raw);
          if (!revision.success || revision.data.revision !== command.expectedRevision)
            throw new Error('Workspace catalog edit conflict');
        }
        if (mutation.value !== undefined || command.kind === 'reconcile-role-schema')
          assertNativeFlockRewriteValue(raw);
        let evidence: AgentRoleSchemaEvidence | undefined;
        if (command.kind === 'reconcile-role-schema') {
          evidence = await options.resolveRoleSchemaEvidence?.(command);
          check(binding, 'write', command);
          if (
            execution?.signal?.aborted ||
            !evidence ||
            !sameSchemaReference(command.evidence, evidence)
          )
            return { changed: false };
        }
        let next =
          command.kind === 'reconcile-role-schema'
            ? planAgentRoleSchemaReconciliation(raw, command, expected.accountId, evidence)
            : mutation.value;
        if (command.kind === 'reconcile-role-schema' && next === undefined)
          return { changed: false };
        if (
          command.kind !== 'reconcile-role-schema' &&
          next !== undefined &&
          raw !== undefined &&
          previous
        ) {
          if (command.kind === 'put-mcp') assertKnownMcpShape(raw);
          const before =
            previous.key[0] === 'agentRole'
              ? serializeAgentRoleRow(previous.value as import('../agent-role').AgentRole)
              : previous.value;
          next = mergeKnownEdits(raw, before, next);
          if (command.kind === 'put-mcp') {
            next = publicMcpServer(next as WorkspaceMcpServerMeta);
            assertPublicMcpServer(next as WorkspaceMcpServerMeta);
          } else if (command.kind === 'put-role') sanitizeRole(next);
        }
        if (next !== undefined) assertNativeFlockRewriteValue(next);
        if (isDeepStrictEqual(raw, next)) return { changed: false };
        try {
          await client.flockBatch(
            namespace,
            room,
            next === undefined
              ? [{ op: 'delete', key: mutation.key }]
              : [{ op: 'put', key: mutation.key, value: next as JsonValue }],
            {
              precondition: { mode: 'cas', expected_room_tx_id: stored.roomTxId },
            }
          );
          return { changed: true };
        } catch (error) {
          if (error instanceof RepoRpcError && error.code === 'precondition_failed' && attempt < 8)
            continue;
          throw error; // Sent writes with unknown outcomes are never replayed.
        }
      }
    },
    async upload(binding) {
      check(binding, 'upload');
      if (!options.confirmUpload)
        throw new Error('Native workspace catalog upload confirmation is unavailable');
      await options.confirmUpload();
      check(binding, 'upload');
    },
  };
}

/** Apply authored public-field changes while leaving unedited opaque fields private. */
function mergeKnownEdits(raw: unknown, before: unknown, next: unknown): unknown {
  if (isDeepStrictEqual(before, next)) return raw;
  if (Array.isArray(before) && Array.isArray(next) && Array.isArray(raw)) {
    const identity = (value: unknown) => {
      const item = record.safeParse(value);
      return item.success ? (item.data.id ?? item.data.machineId) : undefined;
    };
    if (next.every((value) => typeof identity(value) === 'string'))
      return next.map((value) => {
        const id = identity(value);
        return mergeKnownEdits(
          raw.find((old) => identity(old) === id),
          before.find((old) => identity(old) === id),
          value
        );
      });
    return next;
  }
  const previous = record.safeParse(before),
    desired = record.safeParse(next),
    stored = record.safeParse(raw);
  if (!previous.success || !desired.success || !stored.success) return next;
  const merged = { ...stored.data };
  for (const key of new Set([...Object.keys(previous.data), ...Object.keys(desired.data)])) {
    if (!Object.hasOwn(desired.data, key)) delete merged[key];
    else
      Object.defineProperty(merged, key, {
        value: mergeKnownEdits(stored.data[key], previous.data[key], desired.data[key]),
        enumerable: true,
        configurable: true,
        writable: true,
      });
  }
  return merged;
}

function assertKnownMcpShape(value: unknown): void {
  const row = record.parse(value);
  const allowed = new Set([
    'id',
    'name',
    'transport',
    'createdAt',
    'updatedAt',
    'description',
    'createdBy',
    'enabledByDefault',
    'connection',
  ]);
  if (Object.keys(row).some((key) => !allowed.has(key)))
    throw new Error('Unsupported MCP configuration fields');
  const connection = record.safeParse(row.connection);
  if (connection.success) {
    const keys =
      connection.data.transport === 'http'
        ? ['transport', 'authentication', 'url', 'bearerToken', 'headers']
        : ['transport', 'authentication', 'command', 'args', 'env', 'envPassthrough'];
    if (Object.keys(connection.data).some((key) => !keys.includes(key)))
      throw new Error('Unsupported MCP connection fields');
  }
}
function sanitizeRole(value: unknown): void {
  const row = record.parse(value);
  const configs = [
    row.runConfig,
    ...(Array.isArray(row.targets)
      ? row.targets.map((target) => record.parse(target).runConfig)
      : []),
  ];
  for (const config of configs) {
    const parsed = record.safeParse(config);
    if (!parsed.success) continue;
    const values = record.safeParse(parsed.data.configOptionValues);
    if (!values.success) continue;
    for (const key of Object.keys(values.data))
      if (isSensitiveAgentRoleConfigOptionKey(key)) {
        const source = config as { configOptionValues: Record<string, unknown> };
        delete source.configOptionValues[key];
      }
  }
}

/** Match the requested probe identity; only the owner's schema is planned. */
function sameSchemaReference(
  request: AgentRoleSchemaEvidence,
  trusted: AgentRoleSchemaEvidence
): boolean {
  return (
    request.target.machineId === trusted.target.machineId &&
    request.target.agentConfigId === trusted.target.agentConfigId &&
    request.target.cliType === trusted.target.cliType &&
    request.target.agentType === trusted.target.agentType &&
    isDeepStrictEqual(request.target.runtimeOverrides, trusted.target.runtimeOverrides) &&
    request.schema.cliType === trusted.schema.cliType &&
    request.schema.agentType === trusted.schema.agentType &&
    request.schema.cacheVersion === trusted.schema.cacheVersion &&
    request.schema.sourceVersion === trusted.schema.sourceVersion &&
    request.schema.fetchedAt === trusted.schema.fetchedAt
  );
}

/** Keeps an unconfirmed startup release with its real owner; never serialized as an IPC DTO. */
class NativeCatalogAcquireCleanupError extends AggregateError {
  readonly #release: () => Promise<void>;
  constructor(startup: unknown, cleanup: unknown, release: () => Promise<void>) {
    super([startup, cleanup], 'Native catalog observation startup/release failed');
    this.#release = release;
  }
  retryCleanup() {
    return this.#release();
  }
}

/**
 * Stable trusted owner over the host's client generations. It borrows clients and
 * never closes the host/client, replays mutations, or affects another reader.
 */
export function createNativeWorkspaceCatalogOwner(
  options: Omit<NativeWorkspaceCatalogOptions, 'client'> & {
    getClient(): Promise<RepoClient>;
    cleanupTimeoutMs?: number;
  }
): WorkspaceCatalogReader &
  WorkspaceCatalogCommands &
  WorkspaceCatalogRoleLookup & { close(): Promise<void> } {
  let closed = false;
  let current:
    | { client: RepoClient; catalog: ReturnType<typeof createNativeWorkspaceCatalog> }
    | undefined;
  type Lease = {
    acquisition?: Promise<void>;
    observation?: import('../workspace-catalog').WorkspaceCatalogObservation;
    closing: boolean;
    release?: Promise<void>;
  };
  const leases = new Set<Lease>();
  const timeoutMs = options.cleanupTimeoutMs ?? 5_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error('Invalid catalog cleanup timeout');
  const bounded = async (work: Promise<void>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new WorkspaceCatalogError(
                  'cleanup_unconfirmed',
                  'Native catalog observation release is unconfirmed'
                )
              ),
            timeoutMs
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const select = async () => {
    if (closed)
      throw new WorkspaceCatalogError('restart_required', 'Native catalog owner is closed');
    let client: RepoClient;
    try {
      client = await options.getClient();
    } catch (cause) {
      throw new WorkspaceCatalogError(
        'restart_required',
        'Native catalog client acquisition failed',
        { cause }
      );
    }
    if (closed || client.connectionState === 'closed')
      throw new WorkspaceCatalogError(
        'restart_required',
        'Native catalog client must be reacquired'
      );
    if (current?.client !== client)
      current = {
        client,
        catalog: createNativeWorkspaceCatalog({
          ...options,
          client,
          authorize: (operation, command) => !closed && options.authorize(operation, command),
        }),
      };
    return current.catalog;
  };
  const release = (lease: Lease): Promise<void> => {
    lease.closing = true;
    if (lease.release) return lease.release;
    const pending = (async () => {
      try {
        await lease.acquisition;
      } catch {
        /* A startup failure may still own an unconfirmed release. */
      }
      await lease.observation?.close();
      leases.delete(lease);
    })();
    lease.release = pending;
    void pending.catch(() => {
      if (lease.release === pending) lease.release = undefined;
    });
    return pending;
  };
  return {
    async read(binding) {
      return (await select()).read(binding);
    },
    async readRole(binding, id) {
      return (await select()).readRole(binding, id);
    },
    async execute(binding, command, execution) {
      return (await select()).execute(binding, command, execution);
    },
    async upload(binding) {
      await (await select()).upload(binding);
    },
    async observe(binding, onUpdate, onError) {
      const lease: Lease = { closing: false };
      leases.add(lease);
      const acquisition = (async () => {
        try {
          const catalog = await select();
          if (closed || lease.closing)
            throw new WorkspaceCatalogError(
              'restart_required',
              'Native catalog observation was closed'
            );
          lease.observation = await catalog.observe(
            binding,
            (update) => {
              if (!closed && !lease.closing) onUpdate(update);
            },
            (error) => {
              if (!closed && !lease.closing) onError(error);
            }
          );
        } catch (error) {
          if (error instanceof NativeCatalogAcquireCleanupError)
            lease.observation = { close: () => error.retryCleanup() };
          if (!lease.observation) leases.delete(lease);
          if (
            !(error instanceof NativeCatalogAcquireCleanupError) &&
            current?.client.connectionState === 'closed'
          )
            throw new WorkspaceCatalogError(
              'restart_required',
              'Native catalog observation owner must be reacquired',
              { cause: error }
            );
          throw error;
        }
      })();
      lease.acquisition = acquisition;
      await acquisition;
      if (closed || lease.closing) {
        await bounded(release(lease));
        throw new WorkspaceCatalogError(
          'restart_required',
          'Native catalog observation was closed'
        );
      }
      return { close: () => bounded(release(lease)) };
    },
    async close() {
      closed = true;
      current = undefined;
      const pending = Promise.allSettled([...leases].map(release)).then((results) => {
        const failures = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : []
        );
        if (failures.length)
          throw new AggregateError(failures, 'Native catalog observation cleanup failed');
      });
      await bounded(pending);
    },
  };
}

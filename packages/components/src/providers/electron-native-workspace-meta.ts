import type { JsonObject } from 'loro-repo';
import { getIpcServices, onIpcEvent } from '../lib/electron-ipc-client';
import {
  WorkspaceMetaIpcError,
  workspaceMetaErrorCodeSchema,
  workspaceMetaCommandSchema,
  parseWorkspaceMetaPublicSnapshot,
  parseWorkspaceMetaEvent,
  type WorkspaceMetaScope,
  type WorkspaceMetaEvent,
  type WorkspaceMetaPublicSnapshot,
  type WorkspaceMetaPublicCommand,
} from '@lody/shared/native-workspace-meta-ipc';
type Snapshot = Omit<WorkspaceMetaPublicSnapshot, 'docs'> & {
  docs: { docId: string; deleted: boolean; meta: JsonObject }[];
};
type Receipt = { outcome: 'committed'; snapshot: Snapshot };
type Reply = { generation: string; snapshot: WorkspaceMetaPublicSnapshot };
export type NativeWorkspaceMetaTransport = {
  read(scope: WorkspaceMetaScope): Promise<Reply>;
  commit(
    request: WorkspaceMetaScope & {
      expectedGeneration: string;
      command: WorkspaceMetaPublicCommand;
    }
  ): Promise<Reply & { outcome: 'committed' }>;
  flush(
    request: WorkspaceMetaScope & { expectedGeneration: string }
  ): Promise<Reply & { outcome: 'committed' }>;
  observe(scope: WorkspaceMetaScope): Promise<Reply & { leaseId: string }>;
  unobserve(request: WorkspaceMetaScope & { leaseId: string }): Promise<{ released: true }>;
  cancelObservation(scope: WorkspaceMetaScope): Promise<{ canceled: true }>;
};
export type NativeWorkspaceMetaHealth = {
  readonly status: 'pending' | 'ready' | 'failed' | 'retired';
  readonly generation?: string;
  readonly error?: WorkspaceMetaIpcError;
};
/** No body author, optimistic Meta cache, raw Flock or replay lives in renderer. */
export function createNativeWorkspaceMetaAdapter(options: {
  readonly registrationId: string;
  requestId(): string;
  readonly transport: NativeWorkspaceMetaTransport;
  listen(receive: (event: WorkspaceMetaEvent) => void): () => void;
  /** Actual SDK constructor, supplied only after its capability has been checked. */
  knownNotCommitted?(error: WorkspaceMetaIpcError): Error;
  onFailure?(error: WorkspaceMetaIpcError): void;
}) {
  const scope = { registrationId: options.registrationId, requestId: options.requestId() };
  let retired = false,
    generation: string | undefined,
    leaseId: string | undefined;
  let requested = false,
    confirmedRelease = false,
    revoked = false,
    writeBlocked = false;
  let acquisition: Promise<Snapshot> | undefined, closing: Promise<void> | undefined;
  let early: WorkspaceMetaEvent | undefined;
  let health: NativeWorkspaceMetaHealth = { status: 'pending' };
  const healthListeners = new Set<() => void>();
  const listeners = new Set<
    (update: { snapshot: Snapshot; by: 'local' | 'sync' | 'live' }) => void
  >();
  const setHealth = (next: NativeWorkspaceMetaHealth) => {
    health = next;
    for (const listener of healthListeners) {
      try {
        listener();
      } catch {}
    }
  };
  const failure = (error: unknown) => {
    const parsed = workspaceMetaErrorCodeSchema.safeParse(
      error && typeof error === 'object' && 'code' in error ? error.code : undefined
    );
    const safe = new WorkspaceMetaIpcError(parsed.success ? parsed.data : 'operation_failed');
    if (
      safe.code === 'access_denied' ||
      safe.code === 'restart_required' ||
      safe.code === 'unavailable'
    )
      revoked = true;
    if (!retired && safe.code !== 'not_committed') {
      setHealth({ status: 'failed', generation, error: safe });
      try {
        options.onFailure?.(safe);
      } catch {}
    }
    return safe;
  };
  const check = () => {
    if (retired || revoked) throw health.error ?? new WorkspaceMetaIpcError('restart_required');
  };
  const snapshot = (reply: Reply): Snapshot => {
    check();
    if (!reply.generation || (generation !== undefined && generation !== reply.generation))
      throw failure(new WorkspaceMetaIpcError('restart_required'));
    generation = reply.generation;
    const result = parseWorkspaceMetaPublicSnapshot(reply.snapshot);
    return {
      ...result,
      docs: result.docs.map((row) => ({ ...row, meta: row.meta as JsonObject })),
    };
  };
  const publish = (event: WorkspaceMetaEvent) => {
    if (
      retired ||
      revoked ||
      event.registrationId !== scope.registrationId ||
      event.requestId !== scope.requestId
    )
      return;
    if (!leaseId) {
      if (!early || event.snapshot.revision >= early.snapshot.revision) early = event;
      return;
    }
    if (event.leaseId !== leaseId) return;
    try {
      const value = snapshot(event);
      for (const listener of listeners) {
        try {
          listener({ snapshot: value, by: event.by });
        } catch {}
      }
    } catch (error) {
      failure(error);
    }
  };
  const detach = options.listen((value) => {
    if (
      !value ||
      value.registrationId !== scope.registrationId ||
      value.requestId !== scope.requestId
    )
      return;
    try {
      publish(parseWorkspaceMetaEvent(value));
    } catch (error) {
      failure(error);
    }
  });
  const ensure = () => {
    check();
    if (acquisition) return acquisition;
    requested = true;
    acquisition = (async () => {
      const reply = await options.transport.observe(scope);
      if (retired) return Promise.reject(new WorkspaceMetaIpcError('restart_required'));
      leaseId = reply.leaseId;
      if (!leaseId) throw new WorkspaceMetaIpcError('operation_failed');
      let initial = snapshot(reply);
      if (early) {
        const pending = early;
        early = undefined;
        if (
          pending.leaseId === leaseId &&
          pending.generation === generation &&
          pending.snapshot.revision > initial.revision
        ) {
          initial = snapshot(pending);
          for (const listener of listeners) {
            try {
              listener({ snapshot: initial, by: pending.by });
            } catch {}
          }
        }
      }
      setHealth({ status: 'ready', generation });
      return initial;
    })().catch((error) => {
      throw failure(error);
    });
    void acquisition.catch(() => undefined);
    return acquisition;
  };
  const barrier = async (reply: Promise<Reply>): Promise<Snapshot> => {
    try {
      return snapshot(await reply);
    } catch (error) {
      throw failure(error);
    }
  };
  const adapter = {
    capability: 'loro-external-metadata-v1' as const,
    async open(listener: (update: { snapshot: Snapshot; by: 'local' | 'sync' | 'live' }) => void) {
      check();
      listeners.add(listener);
      try {
        return {
          snapshot: await ensure(),
          unsubscribe: () => {
            listeners.delete(listener);
          },
        };
      } catch (error) {
        listeners.delete(listener);
        throw error;
      }
    },
    async read() {
      await ensure();
      return barrier(options.transport.read(scope));
    },
    async commit(command: unknown): Promise<Receipt> {
      await ensure();
      check();
      if (writeBlocked) throw new WorkspaceMetaIpcError('operation_failed');
      let parsed: WorkspaceMetaPublicCommand;
      try {
        parsed = workspaceMetaCommandSchema.parse(command);
      } catch {
        const error = new WorkspaceMetaIpcError('not_committed');
        throw options.knownNotCommitted?.(error) ?? error;
      }
      try {
        const reply = await options.transport.commit({
          ...scope,
          expectedGeneration: generation!,
          command: parsed,
        });
        if (reply.outcome !== 'committed') throw new WorkspaceMetaIpcError('operation_failed');
        return { outcome: 'committed', snapshot: snapshot(reply) };
      } catch (error) {
        const safe = failure(error);
        if (safe.code !== 'not_committed') writeBlocked = true;
        throw safe.code === 'not_committed' ? (options.knownNotCommitted?.(safe) ?? safe) : safe;
      }
    },
    async flush(): Promise<Receipt> {
      await ensure();
      check();
      if (writeBlocked) throw new WorkspaceMetaIpcError('operation_failed');
      try {
        const reply = await options.transport.flush({ ...scope, expectedGeneration: generation! });
        if (reply.outcome !== 'committed') throw new WorkspaceMetaIpcError('operation_failed');
        return { outcome: 'committed', snapshot: snapshot(reply) };
      } catch (error) {
        writeBlocked = true;
        throw failure(error);
      }
    },
  };
  return {
    adapter,
    getHealth: () => health,
    subscribeHealth(listener: () => void) {
      healthListeners.add(listener);
      return () => {
        healthListeners.delete(listener);
      };
    },
    get cleanupPending() {
      return requested && !confirmedRelease;
    },
    close(): Promise<void> {
      if (!retired) {
        retired = true;
        detach();
        listeners.clear();
        early = undefined;
        setHealth({ status: 'retired', generation });
      }
      if (confirmedRelease || !requested) return Promise.resolve();
      if (closing) return closing;
      closing = (async () => {
        try {
          if (leaseId) {
            const result = await options.transport.unobserve({ ...scope, leaseId });
            if (result.released !== true) throw new Error('Unconfirmed exact release');
          } else {
            const result = await options.transport.cancelObservation(scope);
            if (result.canceled !== true) throw new Error('Unconfirmed exact cancellation');
          }
          confirmedRelease = true;
        } catch {
          throw new WorkspaceMetaIpcError('cleanup_unconfirmed');
        }
      })().finally(() => {
        closing = undefined;
      });
      return closing;
    },
  };
}
export function createElectronNativeWorkspaceMeta(
  options: Omit<Parameters<typeof createNativeWorkspaceMetaAdapter>[0], 'transport' | 'listen'>
) {
  const services = getIpcServices();
  if (!services) throw new WorkspaceMetaIpcError('unavailable');
  const meta = services.workspaceMeta;
  const invoke = async <A>(method: string, work: () => Promise<A>): Promise<A> => {
    try {
      return await work();
    } catch (error) {
      const message = error instanceof Error ? error.message : '',
        prefix = `Error invoking remote method 'workspaceMeta.${method}': `,
        detail = message.startsWith(prefix) ? message.slice(prefix.length) : '',
        code = workspaceMetaErrorCodeSchema.safeParse(
          detail.match(/^(?:Error|WorkspaceMetaIpcError): workspace_meta_([a-z_]+)$/)?.[1]
        );
      throw new WorkspaceMetaIpcError(code.success ? code.data : 'operation_failed');
    }
  };
  return createNativeWorkspaceMetaAdapter({
    ...options,
    transport: {
      read: (scope) => invoke('read', () => meta.read(scope)),
      commit: (request) => invoke('commit', () => meta.commit(request)),
      flush: (request) => invoke('flush', () => meta.flush(request)),
      observe: (scope) => invoke('observe', () => meta.observe(scope)),
      unobserve: (request) => invoke('unobserve', () => meta.unobserve(request)),
      cancelObservation: (scope) =>
        invoke('cancelObservation', () => meta.cancelObservation(scope)),
    },
    listen: (receive) => onIpcEvent('workspaceMeta.event', receive),
  });
}

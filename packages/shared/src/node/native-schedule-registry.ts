import { RepoRpcError, type JsonValue, type RepoClient } from '@loro-dev/loro-repo-client';
import { createNativeMachineCatalogObservations } from './native-machine-catalog-observations';
export { NativeMachineCatalogCleanupError as NativeScheduleRegistryCleanupError } from './native-machine-catalog-observations';
import { assertNativeFlockRewriteValue } from './native-flock-value';
import { getScheduleRegistryFlockDocId, canonicalScheduleJson } from '../schedule-registry';
import {
  planScheduleRegistry,
  type ScheduleRegistryCommand,
  projectScheduleRegistry,
  type ScheduleRegistryPort,
} from '../schedule-registry-port';
import type { WorkspaceId } from '../ids';

const wire = (value: unknown): JsonValue => {
  if (Array.isArray(value)) return value.map(wire);
  if (value && typeof value === 'object' && !(value instanceof Uint8Array))
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, wire(entry)])
    ) as JsonValue;
  return value as JsonValue;
};
/** Trusted whole-SR owner only. A sent mutation is never retried on another client generation. */
export type NativeScheduleRegistryOptions = {
  workspaceId: WorkspaceId;
  namespace: string;
  writer: string;
  getClient(): Promise<RepoClient>;
  assertAccess(): void;
  /** Trusted policy, checked against the same rows protected by the CAS write. */
  authorizeCommand?(
    command: ScheduleRegistryCommand,
    rows: Parameters<typeof planScheduleRegistry>[0]
  ): void;
  flush(): Promise<void>;
  sync?(): Promise<void>;
  authority?: { current(): boolean; subscribe(listener: () => void): () => void };
  closeTimeoutMs?: number;
};
export function createNativeScheduleRegistry(
  options: NativeScheduleRegistryOptions
): ScheduleRegistryPort & { retire(): void; close(): Promise<void> } {
  const room = { kind: 'flock' as const, id: getScheduleRegistryFlockDocId(options.workspaceId) };
  let ownerClosed = false;
  const observationOwners = new Set<ReturnType<typeof createNativeMachineCatalogObservations>>();
  const acquisitions = new Set<Promise<unknown>>();
  const operations = new Set<Promise<unknown>>();
  const owned = <A>(run: () => Promise<A>): Promise<A> => {
    const operation = run();
    operations.add(operation);
    void operation.finally(() => operations.delete(operation)).catch(() => {});
    return operation;
  };
  const waitClose = async (work: Promise<unknown>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Schedule registry release remains pending')),
            options.closeTimeoutMs ?? 5000
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const check = () => {
    if (ownerClosed) throw new Error('Schedule registry owner is closed');
    options.assertAccess();
  };
  return {
    workspaceId: options.workspaceId,
    async exportRows() {
      check();
      const client = await options.getClient();
      check();
      const state = await client.flockScan(options.namespace, room);
      check();
      assertNativeFlockRewriteValue(state.entries);
      return state.entries;
    },
    async read() {
      check();
      const client = await options.getClient();
      check();
      const state = await client.flockScan(options.namespace, room);
      check();
      return projectScheduleRegistry(
        state.entries,
        client.connectionState === 'connected' && options.authority?.current() === true
      );
    },
    execute(command) {
      return owned(async () => {
        check();
        const client = await options.getClient();
        for (let attempt = 0; attempt < 8; attempt++) {
          check();
          const state = await client.flockScan(options.namespace, room);
          check();
          options.authorizeCommand?.(command, state.entries);
          const ops = planScheduleRegistry(state.entries, command);
          if (!ops.length) return { changed: false };
          for (const op of ops)
            if (op.op === 'put') {
              const raw = state.entries.find(
                (entry) => canonicalScheduleJson(entry.key) === canonicalScheduleJson(op.key)
              )?.value;
              assertNativeFlockRewriteValue(raw);
              assertNativeFlockRewriteValue(op.value);
            }
          check();
          try {
            await client.flockBatch(
              options.namespace,
              room,
              ops.map((op) => (op.op === 'put' ? { ...op, value: wire(op.value) } : op)),
              {
                writer: options.writer,
                precondition: { mode: 'cas', expected_room_tx_id: state.roomTxId },
              }
            );
            check();
            return { changed: true };
          } catch (error) {
            if (error instanceof RepoRpcError && error.code === 'precondition_failed') continue;
            throw error;
          }
        }
        throw new Error('Schedule registry changed during bounded CAS retries');
      });
    },
    flush() {
      return owned(async () => {
        check();
        await options.flush();
        check();
      });
    },
    sync() {
      return owned(async () => {
        check();
        await options.sync?.();
        check();
      });
    },
    observe(update, onError) {
      const acquisition = (async () => {
        check();
        const client = await options.getClient();
        check();
        let retired = false;
        let off = () => {};
        let offAuthority = () => {};
        const owner = createNativeMachineCatalogObservations(
          client,
          options.closeTimeoutMs ?? 5000
        );
        observationOwners.add(owner);
        const publish = (rows: unknown) => {
          if (retired) return;
          try {
            check();
            update(
              projectScheduleRegistry(
                rows as Parameters<typeof projectScheduleRegistry>[0],
                client.connectionState === 'connected' && options.authority?.current() === true
              )
            );
          } catch (error) {
            onError(error);
          }
        };
        const acquired = await owner.acquire(
          () => client.flockSubscribe(options.namespace, room, {}, publish),
          () => {
            retired = true;
            off();
            offAuthority();
          }
        );
        try {
          check();
          off = client.onConnectionStateChange((state) => {
            if (retired) return;
            if (state === 'closed') {
              const error = new Error('Schedule registry restart required');
              Object.assign(error, { code: 'restart_required' });
              onError(error);
            } else publish(acquired.currentValue());
          });
          offAuthority =
            options.authority?.subscribe(() => publish(acquired.currentValue())) ?? (() => {});
          publish(acquired.currentValue());
          return {
            close: async () => {
              await owner.close();
              observationOwners.delete(owner);
            },
          };
        } catch (error) {
          // A failed native ACK keeps its original helper/cleanup closure. Its
          // retry must never use SDK's locally-forgotten no-op unsubscribe.
          await acquired.observation.close();
          observationOwners.delete(owner);
          throw error;
        }
      })();
      acquisitions.add(acquisition);
      void acquisition.finally(() => acquisitions.delete(acquisition)).catch(() => {});
      return acquisition;
    },
    retire() {
      ownerClosed = true;
      for (const owner of observationOwners) owner.retire();
    },
    async close() {
      ownerClosed = true;
      for (const owner of observationOwners) owner.retire();
      const failures: unknown[] = [];
      try {
        await waitClose(Promise.allSettled([...operations]));
      } catch (error) {
        failures.push(error);
      }
      try {
        await waitClose(Promise.allSettled([...acquisitions]));
      } catch (error) {
        failures.push(error);
      }
      const results = await Promise.allSettled(
        [...observationOwners].map(async (owner) => {
          await owner.close();
          observationOwners.delete(owner);
        })
      );
      for (const result of results) if (result.status === 'rejected') failures.push(result.reason);
      if (failures.length)
        throw new AggregateError(failures, 'Schedule registry owner cleanup unconfirmed');
    },
  };
}

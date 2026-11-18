import {
  WorkspaceCatalogError,
  assertWorkspaceCatalogBinding,
  type WorkspaceCatalogReader,
  type WorkspaceCatalogCommands,
  type WorkspaceCatalogBinding,
} from '@lody/shared';
import type { WorkspaceCatalogIpcEvent } from '@lody/shared/workspace-catalog-ipc';
import { getIpcServices, onIpcEvent, type IpcServices } from '../lib/electron-ipc-client';

type Services = Pick<
  IpcServices['localPlatform'],
  | 'readWorkspaceCatalog'
  | 'executeWorkspaceCatalog'
  | 'uploadWorkspaceCatalog'
  | 'observeWorkspaceCatalog'
  | 'unobserveWorkspaceCatalog'
>;
/** No local Repo fallback. Each observer's server lease is released by its exact request tuple. */
export function createNativeWorkspaceCatalogIpc(
  binding: WorkspaceCatalogBinding,
  registrationId: string,
  services: Services,
  listen: (handler: (event: WorkspaceCatalogIpcEvent) => void) => () => void
) {
  let closed = false;
  type Observation = { close(): Promise<void> };
  const observations = new Set<Observation>();
  const check = (actual: WorkspaceCatalogBinding) => {
    assertWorkspaceCatalogBinding(binding, actual);
    if (closed)
      throw new WorkspaceCatalogError('restart_required', 'Native renderer catalog closed');
  };
  const reader: WorkspaceCatalogReader = {
    async read(actual) {
      check(actual);
      const projection = await services.readWorkspaceCatalog(registrationId);
      check(actual);
      return projection;
    },
    async observe(actual, onUpdate, onError) {
      check(actual);
      const requestId = crypto.randomUUID();
      let closing = false;
      let leaseId: string | undefined;
      let buffered: WorkspaceCatalogIpcEvent | undefined;
      let release: Promise<void> | undefined;
      const publish = (event: WorkspaceCatalogIpcEvent) => {
        if (
          closing ||
          closed ||
          event.registrationId !== registrationId ||
          event.requestId !== requestId
        )
          return;
        if (!leaseId) {
          buffered = event;
          return;
        }
        if (event.leaseId !== leaseId) return;
        if (event.type === 'snapshot') onUpdate(event.update);
        else
          onError(
            new WorkspaceCatalogError(
              event.code,
              'Native catalog observation requires reacquisition'
            )
          );
      };
      const unsubscribe = listen(publish);
      const acquisition = Promise.resolve().then(() =>
        services.observeWorkspaceCatalog({ registrationId, requestId })
      );
      const observation = {
        close: (): Promise<void> => {
          closing = true;
          unsubscribe();
          if (release) return release;
          const operation = (async () => {
            let receipt;
            try {
              receipt = await acquisition;
            } catch {
              observations.delete(observation);
              return;
            }
            await services.unobserveWorkspaceCatalog({
              registrationId,
              requestId,
              leaseId: receipt.leaseId,
            });
            observations.delete(observation);
          })();
          release = operation;
          void operation.catch(() => {
            if (release === operation) release = undefined;
          });
          return operation;
        },
      };
      observations.add(observation);
      try {
        const receipt = await acquisition;
        leaseId = receipt.leaseId;
        if (closing || closed) {
          await observation.close();
          throw new WorkspaceCatalogError('restart_required', 'Native catalog observation retired');
        }
        if (buffered) publish(buffered);
        buffered = undefined;
        return observation;
      } catch (cause) {
        try {
          await observation.close();
        } catch (cleanup) {
          throw new AggregateError(
            [cause, cleanup],
            'Native catalog acquisition and cleanup failed'
          );
        }
        throw new WorkspaceCatalogError(
          'restart_required',
          'Native catalog observation acquisition failed',
          { cause }
        );
      }
    },
  };
  const commands: WorkspaceCatalogCommands = {
    async execute(actual, command, options) {
      check(actual);
      if (options?.signal?.aborted) return { changed: false };
      return services.executeWorkspaceCatalog(registrationId, command);
    },
    async upload(actual) {
      check(actual);
      await services.uploadWorkspaceCatalog(registrationId);
    },
  };
  return {
    reader,
    commands,
    async close() {
      closed = true;
      const results = await Promise.allSettled(
        [...observations].map((observer) => observer.close())
      );
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      );
      if (failures.length)
        throw new AggregateError(failures, 'Native renderer catalog release failed');
    },
  };
}
export function createElectronNativeWorkspaceCatalog(
  binding: WorkspaceCatalogBinding,
  registrationId: string
) {
  const services = getIpcServices();
  if (!services) throw new Error('Native workspace catalog IPC unavailable');
  return createNativeWorkspaceCatalogIpc(
    binding,
    registrationId,
    services.localPlatform,
    (handler) => onIpcEvent('localPlatform.workspaceCatalog', handler)
  );
}

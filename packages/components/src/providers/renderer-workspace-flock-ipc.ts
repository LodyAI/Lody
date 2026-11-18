import { getIpcServices, onIpcEvent, type IpcServices } from '../lib/electron-ipc-client';
import {
  rendererWfBindingKey,
  rendererWfOwnerSchema,
  rendererWfRequestSchema,
  rendererWfAckSchema,
  rendererWfRegistrationSchema,
  rendererWfPublishedOwnerSchema,
  type RendererWfPublishedOwner,
  type RendererWfRequest,
  type RendererWfRegistration,
} from '@lody/shared/renderer-room-migration';
import type { RendererWorkspaceFlockMigrationPort } from './renderer-workspace-flock-freeze';

type Services = Pick<
  IpcServices['localPlatform'],
  | 'registerWorkspaceFlock'
  | 'readyWorkspaceFlock'
  | 'acknowledgeWorkspaceFlock'
  | 'retireWorkspaceFlock'
>;
/** Exact product IPC contract, injectable for lifecycle tests without a second implementation. */
export function createRendererWorkspaceFlockIpcPort(
  services: Services,
  listen: (handler: (request: RendererWfRequest) => void) => () => void,
  listenOwner?: (handler: (owner: RendererWfPublishedOwner) => void) => () => void
): RendererWorkspaceFlockMigrationPort {
  return {
    async start(binding, onRequest, signal, onOwner) {
      let closed = false;
      let registrationId: string | undefined;
      let closing: Promise<void> | undefined;
      let registration: Promise<RendererWfRegistration>;
      const pending = new Set<Promise<void>>();
      const expected = rendererWfBindingKey(binding);
      const unsubscribe = listen((message) => {
        const parsed = rendererWfRequestSchema.safeParse(message);
        if (!parsed.success) return;
        const request = parsed.data;
        // An older runtime in the same WebContents must never answer a newer
        // registration's request, even while its asynchronous close is pending.
        if (request.registrationId !== registrationId) return;
        let task: Promise<void>;
        task = (async () => {
          let ack;
          try {
            if (closed || rendererWfBindingKey(request.binding) !== expected)
              throw new Error('Renderer WF owner retired');
            ack = rendererWfAckSchema.parse(await onRequest(request));
          } catch {
            ack = {
              ...request,
              failure: closed
                ? ('owner_retired' as const)
                : request.phase === 'freeze'
                  ? ('drain_failed' as const)
                  : ('capture_failed' as const),
            };
          }
          await services.acknowledgeWorkspaceFlock(ack);
        })().finally(() => pending.delete(task));
        pending.add(task);
        void task.catch(() => {});
      });
      const unsubscribeOwner = listenOwner?.((message) => {
        const parsed = rendererWfPublishedOwnerSchema.safeParse(message);
        if (
          closed ||
          !parsed.success ||
          parsed.data.registrationId !== registrationId ||
          rendererWfBindingKey(parsed.data.binding) !== expected
        )
          return;
        onOwner?.(parsed.data);
      });
      const close = (): Promise<void> => {
        if (closing) return closing;
        closed = true;
        unsubscribe();
        unsubscribeOwner?.();
        signal?.removeEventListener('abort', abort);
        closing = (async () => {
          // A cancelled register may return after a replacement runtime has
          // registered. Retire only its returned ticket, never that replacement.
          let registered: RendererWfRegistration | undefined;
          try {
            registered = await registration;
          } catch {}
          if (registered) await services.retireWorkspaceFlock(registered.registrationId);
          const results = await Promise.allSettled([...pending]);
          const errors = results.flatMap((result) =>
            result.status === 'rejected' ? [result.reason] : []
          );
          if (errors.length)
            throw new AggregateError(errors, 'Renderer WF acknowledgement release failed');
        })().catch((cause) => {
          closing = undefined;
          throw cause;
        });
        return closing;
      };
      const abort = () => {
        void close().catch(() => {});
      };
      registration = Promise.resolve()
        .then(() => services.registerWorkspaceFlock())
        .then((value) => {
          const owner = rendererWfRegistrationSchema.parse(value);
          registrationId = owner.registrationId;
          return owner;
        });
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
      try {
        const registered = await registration;
        if (closed) {
          await close();
          throw signal?.reason ?? new Error('Renderer WF registration retired');
        }
        if (rendererWfBindingKey(registered.binding) !== expected)
          throw new Error('Renderer WF trusted startup identity mismatch');
        // Listener precedes ready; main queues pushes until this exact ticket's
        // handshake and returns a fresh durable owner, not the register snapshot.
        const owner = rendererWfOwnerSchema.parse(
          await services.readyWorkspaceFlock(registered.registrationId)
        );
        if (closed) {
          await close();
          throw signal?.reason ?? new Error('Renderer WF registration retired');
        }
        if (rendererWfBindingKey(owner.binding) !== expected)
          throw new Error('Renderer WF ready identity mismatch');
        return { owner, registrationId: registered.registrationId, close };
      } catch (cause) {
        try {
          await close();
        } catch (cleanup) {
          throw new AggregateError([cause, cleanup], 'Renderer WF registration and cleanup failed');
        }
        throw cause;
      }
    },
  };
}

/** Local Electron composition only: no HTTP, cloud token, engine API or path crosses the bridge. */
export function createElectronRendererWorkspaceFlockMigrationPort(): RendererWorkspaceFlockMigrationPort | null {
  if (typeof window === 'undefined' || window.__LODY_ELECTRON__ !== true) return null;
  const services = getIpcServices();
  return services
    ? createRendererWorkspaceFlockIpcPort(
        services.localPlatform,
        (handler) => onIpcEvent('localPlatform.workspaceFlockMigration', handler),
        (handler) => onIpcEvent('localPlatform.workspaceFlockOwner', handler)
      )
    : null;
}

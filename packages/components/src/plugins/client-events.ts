import type {
  ClientHostEventMap,
  ClientHostEventType,
  ClientPluginRegistry,
} from '@lody/plugin-sdk/client';

// The workspace is part of dispatch, not a predicate supplied by plugin code.
export class ClientPluginEvents {
  private readonly target = new EventTarget();

  publish<K extends ClientHostEventType>(type: K, detail: ClientHostEventMap[K]): void {
    this.target.dispatchEvent(new CustomEvent(type, { detail }));
  }

  subscribe(
    workspaceId: string,
    signal: AbortSignal,
    report: (error: unknown) => void
  ): ClientPluginRegistry['events'] {
    return {
      on: <K extends ClientHostEventType>(
        type: K,
        handler: (event: ClientHostEventMap[K]) => void | Promise<void>
      ) => {
        let active = true;
        const receive = (event: Event) => {
          const payload = (event as CustomEvent<ClientHostEventMap[K]>).detail;
          if (payload.workspace.workspaceId !== workspaceId) return;
          queueMicrotask(() => {
            if (!active || signal.aborted) return;
            void Promise.resolve()
              .then(() => {
                if (active && !signal.aborted) return handler(structuredClone(payload));
              })
              .catch(report);
          });
        };
        this.target.addEventListener(type, receive, { signal });
        return () => {
          active = false;
          this.target.removeEventListener(type, receive);
        };
      },
    };
  }
}
export const clientPluginEvents = new ClientPluginEvents();

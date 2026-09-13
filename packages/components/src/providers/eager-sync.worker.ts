import { runEagerSyncWorkerTask } from './eager-sync-worker-task';
import type {
  EagerSyncWorkerInput,
  EagerSyncWorkerOutput,
  LocalSyncEvent,
} from './eager-sync-worker-protocol';

const worker = self as unknown as {
  onmessage: ((event: MessageEvent<EagerSyncWorkerInput>) => void) | null;
  postMessage(message: EagerSyncWorkerOutput): void;
};
let started = false;
let connected = false;
let authId = 0;
const authRequests = new Map<number, (token: string | undefined) => void>();
const messageListeners = new Set<(message: LocalSyncEvent) => void>();
const statusListeners = new Set<(connected: boolean) => void>();

worker.onmessage = ({ data }) => {
  if (data.type === 'local-event') {
    for (const listener of messageListeners) listener(data.event);
  } else if (data.type === 'local-status') {
    connected = data.connected;
    for (const listener of statusListeners) listener(connected);
  } else if (data.type === 'auth-result') {
    authRequests.get(data.id)?.(data.token);
    authRequests.delete(data.id);
  } else if (!started) {
    started = true;
    connected = data.connected;
    void runEagerSyncWorkerTask(data, {
      connection: {
        send: (message) => worker.postMessage({ type: 'local-send', message }),
        isConnected: () => connected,
        onMessage: (listener) => {
          messageListeners.add(listener);
          return () => {
            messageListeners.delete(listener);
          };
        },
        onStatusChange: (listener) => {
          statusListeners.add(listener);
          listener(connected);
          return () => {
            statusListeners.delete(listener);
          };
        },
      },
      auth: (context) =>
        new Promise((resolve) => {
          const id = ++authId;
          authRequests.set(id, resolve);
          worker.postMessage({ type: 'auth', id, reason: context?.reason });
        }),
    }).then(
      (outcome) => worker.postMessage({ type: 'complete', outcome }),
      () => worker.postMessage({ type: 'complete', outcome: 'failed' })
    );
  }
};

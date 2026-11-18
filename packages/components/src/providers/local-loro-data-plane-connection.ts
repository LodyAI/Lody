import {
  LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
  type LocalLoroDataPlaneServerMessage,
} from '@lody/shared/local-loro-data-plane';
import type { LocalLoroDataPlaneConnection } from '@lody/shared/local-loro-transport';
import { getIpcServices, onIpcEvent, sendIpc } from '@/lib/electron-ipc-client';

export function createLocalLoroDataPlaneConnection(options?: {
  presence: {
    workspaceId: string;
    peerId: string;
    onMessage(message: Extract<LocalLoroDataPlaneServerMessage, { type: 'presence' }>): void;
    onDisconnect?(): void;
  };
}): {
  connection: LocalLoroDataPlaneConnection;
  dispose: () => void;
} | null {
  if (!getIpcServices()) return null;

  // The server registers even a zero-room client on its first message. Listen
  // before subscribing/connecting so that initial presence cannot outrun us.
  let disposed = false;
  const unsubscribePresence = options
    ? onIpcEvent('loro.event', (message) => {
        if (
          !disposed &&
          message.type === 'presence' &&
          message.workspaceId === options.presence.workspaceId
        )
          options.presence.onMessage(message);
      })
    : () => {};
  let connected = false;
  const statusListeners = new Set<(connected: boolean) => void>();
  const setConnected = (next: boolean) => {
    if (disposed || connected === next) return;
    connected = next;
    for (const listener of statusListeners) listener(next);
    if (!next) options?.presence.onDisconnect?.();
    if (next && options)
      sendIpc('loro.send', {
        type: 'ping',
        protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
        workspaceId: options.presence.workspaceId,
        peerId: options.presence.peerId,
      });
  };
  const unsubscribeStatus = onIpcEvent('loro.status', setConnected);
  sendIpc('loro.subscribe', null);
  void getIpcServices()!.loro.isConnected().then(setConnected);

  return {
    connection: {
      send: (message) => sendIpc('loro.send', message),
      onMessage: (listener) => onIpcEvent('loro.event', listener),
      onStatusChange: (listener) => {
        statusListeners.add(listener);
        listener(connected);
        return () => statusListeners.delete(listener);
      },
      isConnected: () => connected,
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribePresence();
      options?.presence.onDisconnect?.();
      unsubscribeStatus();
      statusListeners.clear();
    },
  };
}

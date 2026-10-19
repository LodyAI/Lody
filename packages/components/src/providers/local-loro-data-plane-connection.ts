import type { LocalLoroDataPlaneConnection } from '@lody/shared/local-loro-transport';
import { getIpcServices, onIpcEvent, sendIpc } from '@/lib/electron-ipc-client';

export function createLocalLoroDataPlaneConnection(): {
  connection: LocalLoroDataPlaneConnection;
  dispose: () => void;
} | null {
  if (!getIpcServices()) return null;

  let connected = false;
  const statusListeners = new Set<(connected: boolean) => void>();
  const setConnected = (next: boolean) => {
    if (connected === next) return;
    connected = next;
    for (const listener of statusListeners) listener(next);
  };
  sendIpc('loro.subscribe', null);
  const unsubscribeStatus = onIpcEvent('loro.status', setConnected);
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
      unsubscribeStatus();
      statusListeners.clear();
    },
  };
}

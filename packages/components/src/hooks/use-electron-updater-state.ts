import { useEffect, useState } from 'react';
import type { ElectronUpdaterState } from '@lody/shared';
import { getIpcServices, onIpcEvent } from '@/lib/electron-ipc-client';

export function useElectronUpdaterState(): ElectronUpdaterState | null {
  const [state, setState] = useState<ElectronUpdaterState | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.__LODY_ELECTRON__) return undefined;

    if (!getIpcServices()) return undefined;

    let active = true;
    let receivedPush = false;
    const unsubscribe = onIpcEvent('updater.state', (s) => {
      receivedPush = true;
      if (active) setState(s);
    });

    void getIpcServices()!
      .updater.getState()
      .then((s) => {
        // The initial read only seeds state until the live stream takes over.
        if (active && !receivedPush) setState(s);
      })
      .catch(() => undefined);

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return state;
}

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import type { ElectronCliState } from '@lody/shared';
import { isElectronRenderer } from '@/lib/electron';
import { getIpcServices, onIpcEvent, sendIpc } from '@/lib/electron-ipc-client';

export type ElectronCliDaemon = {
  /** Latest daemon state, or null before the first snapshot (or outside Electron). */
  state: ElectronCliState | null;
  /** Current lifecycle phase (defaults to `starting` before the first snapshot). */
  phase: ElectronCliState['phase'];
  isRestarting: boolean;
  isTerminating: boolean;
  /** Restart / start the local CLI daemon; shows a toast on failure. */
  restart: () => Promise<void>;
  /** Terminate the local CLI daemon; shows a toast on failure. */
  terminate: () => Promise<void>;
};

/**
 * Subscribes to the Electron CLI daemon (the background process that runs local
 * agents and terminals) and exposes restart/terminate controls with in-place
 * loading flags. Outside Electron everything is inert. Shared by the terminal
 * dock host (which only needs `phase`) and the Settings daemon row.
 */
export function useElectronCliDaemon(): ElectronCliDaemon {
  const { t } = useTranslation();
  const [state, setState] = useState<ElectronCliState | null>(null);
  const [isRestarting, setIsRestarting] = useState(false);
  const [isTerminating, setIsTerminating] = useState(false);

  useEffect(() => {
    if (!isElectronRenderer()) return undefined;
    if (!getIpcServices()) return undefined;

    let active = true;
    sendIpc('cli.subscribe', null);
    void getIpcServices()!
      .cli.getState()
      .then((next) => {
        if (active) setState(next);
      })
      .catch(() => undefined);

    const unsubscribe = onIpcEvent('cli.state', (next) => {
      if (active) setState(next);
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const restart = useCallback(async () => {
    if (!getIpcServices()) return;
    setIsRestarting(true);
    try {
      const result = await getIpcServices()!.cli.restart();
      if (!result.ok) {
        toast.error(result.error ?? t('sidebar.cli.restartFailed', 'Failed to restart CLI.'));
      }
    } finally {
      setIsRestarting(false);
    }
  }, [t]);

  const terminate = useCallback(async () => {
    if (!getIpcServices()) return;
    setIsTerminating(true);
    try {
      const result = await getIpcServices()!.cli.terminate();
      if (!result.ok) {
        toast.error(result.error ?? t('sidebar.cli.terminateFailed', 'Failed to terminate CLI.'));
      }
    } finally {
      setIsTerminating(false);
    }
  }, [t]);

  return {
    state,
    phase: state?.phase ?? 'starting',
    isRestarting,
    isTerminating,
    restart,
    terminate,
  };
}

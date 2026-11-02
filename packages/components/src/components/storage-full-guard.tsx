import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ElectronStorageGuardState } from '@lody/shared';
import { Button } from '@lody/ui/button';
import { AlertDialog } from '@/ui/dialog';
import { getIpcServices, onIpcEvent } from '@/lib/electron-ipc-client';
import { formatFileSize } from '@/lib/session-file-presentation';

function useElectronStorageGuardState(): ElectronStorageGuardState | null {
  const [state, setState] = useState<ElectronStorageGuardState | null>(null);

  useEffect(() => {
    const services = getIpcServices();
    if (!services) return undefined;
    let active = true;
    let receivedPush = false;
    const unsubscribe = onIpcEvent('storageGuard.state', (next) => {
      receivedPush = true;
      if (active) setState(next);
    });
    void services.storageGuard
      .getState()
      .then((next) => {
        if (active && !receivedPush) setState(next);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return state;
}

/**
 * Stops the desktop once the main process confirms the disk holding Lody data is
 * full (`services/storage-guard.ts`). The dialog cannot be dismissed: the way out
 * is freeing space and relaunching, or quitting. Background agents keep running
 * until then.
 */
export function StorageFullGuard() {
  const state = useElectronStorageGuardState();
  if (state?.blocked !== true) return null;
  return <StorageFullDialogView state={state} />;
}

export function StorageFullDialogView({ state }: { state: ElectronStorageGuardState }) {
  const { t } = useTranslation();
  const [pending, setPending] = useState<'relaunch' | 'quit' | null>(null);
  const [stillLow, setStillLow] = useState(false);
  const [checkFailed, setCheckFailed] = useState(false);
  const space = state.volume
    ? {
        free: formatFileSize(state.volume.freeBytes),
        needed: formatFileSize(state.volume.resumeFreeBytes),
      }
    : null;

  const relaunch = () => {
    const services = getIpcServices();
    if (!services) return;
    setPending('relaunch');
    setCheckFailed(false);
    void services.storageGuard
      .relaunchIfSpaceFreed()
      .then((outcome) => {
        setStillLow(outcome === 'still_low');
        setCheckFailed(outcome === 'check_failed');
      })
      .catch(() => setCheckFailed(true))
      .finally(() => setPending(null));
  };

  const quit = () => {
    const services = getIpcServices();
    if (!services) return;
    setPending('quit');
    void services.storageGuard
      .quit()
      .catch(() => undefined)
      .finally(() => setPending(null));
  };

  return (
    <AlertDialog.Root open>
      <AlertDialog.Content>
        <AlertDialog.Header>
          <AlertDialog.Title>{t('storageGuard.title')}</AlertDialog.Title>
          <AlertDialog.Description>
            {space !== null
              ? t('storageGuard.description', space)
              : t('storageGuard.descriptionUnknownSpace')}
          </AlertDialog.Description>
          <AlertDialog.Description>{t('storageGuard.agentsKeepRunning')}</AlertDialog.Description>
          {stillLow && space !== null ? (
            <AlertDialog.Description role="status">
              {t('storageGuard.stillLow', space)}
            </AlertDialog.Description>
          ) : null}
          {checkFailed ? (
            <AlertDialog.Description role="status">
              {t('storageGuard.checkFailed')}
            </AlertDialog.Description>
          ) : null}
        </AlertDialog.Header>
        <AlertDialog.Footer>
          <Button variant="secondary" disabled={pending !== null} onClick={quit}>
            {t('storageGuard.quit')}
          </Button>
          <Button disabled={pending !== null} onClick={relaunch}>
            {pending === 'relaunch' ? t('storageGuard.checking') : t('storageGuard.relaunch')}
          </Button>
        </AlertDialog.Footer>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}

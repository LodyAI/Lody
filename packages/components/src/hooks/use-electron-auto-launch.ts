import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { getIpcServices, type IpcServices } from '@/lib/electron-ipc-client';

type PendingAutoLaunchOperation = 'read' | 'enabled' | 'hide-window' | null;
type AutoLaunchStatus = Awaited<ReturnType<IpcServices['app']['getAutoLaunchStatus']>>;

export function useElectronAutoLaunch(isElectron: boolean) {
  const { t } = useTranslation();
  const [supported, setSupported] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [hideWindowOnAutoLaunch, setHideWindowOnAutoLaunch] = useState(false);
  const [pendingOperation, setPendingOperation] = useState<PendingAutoLaunchOperation>(
    isElectron ? 'read' : null
  );

  useEffect(() => {
    const services = getIpcServices();
    const getAutoLaunchStatus = services
      ? services.app.getAutoLaunchStatus.bind(services.app)
      : undefined;
    if (!isElectron || typeof window === 'undefined' || !getAutoLaunchStatus) {
      setSupported(false);
      setEnabled(false);
      setHideWindowOnAutoLaunch(false);
      setPendingOperation(null);
      return undefined;
    }

    let active = true;
    setPendingOperation('read');
    void getAutoLaunchStatus()
      .then((result) => {
        if (!active) return;
        setSupported(result.supported);
        setEnabled(result.enabled);
        setHideWindowOnAutoLaunch(result.hideWindowOnAutoLaunch);
      })
      .catch(() => {
        if (!active) return;
        setSupported(false);
        setEnabled(false);
        setHideWindowOnAutoLaunch(false);
      })
      .finally(() => {
        if (active) {
          setPendingOperation(null);
        }
      });

    return () => {
      active = false;
    };
  }, [isElectron]);

  const updateStateFromResult = useCallback((result: AutoLaunchStatus) => {
    setSupported(result.supported);
    setEnabled(result.enabled);
    setHideWindowOnAutoLaunch(result.hideWindowOnAutoLaunch);
  }, []);

  const updateEnabled = useCallback(
    async (checked: boolean) => {
      const services = getIpcServices();
      if (!isElectron || !services) return;

      const previous = enabled;
      setEnabled(checked);
      setPendingOperation('enabled');
      try {
        const result = await services.app.setAutoLaunchEnabled(checked);
        updateStateFromResult(result);
        if (!result.ok) {
          toast.error(
            t('settings.general.autoLaunch.toggleFailed', 'Failed to update auto launch')
          );
        }
      } catch {
        setEnabled(previous);
        toast.error(t('settings.general.autoLaunch.toggleFailed', 'Failed to update auto launch'));
      } finally {
        setPendingOperation(null);
      }
    },
    [enabled, isElectron, t, updateStateFromResult]
  );

  const updateHideWindow = useCallback(
    async (checked: boolean) => {
      const services = getIpcServices();
      if (!isElectron || !services) return;

      const previous = hideWindowOnAutoLaunch;
      setHideWindowOnAutoLaunch(checked);
      setPendingOperation('hide-window');
      try {
        const result = await services.app.setAutoLaunchHideWindow(checked);
        updateStateFromResult(result);
        if (!result.ok) {
          toast.error(
            t(
              'settings.general.autoLaunch.hideWindowToggleFailed',
              'Failed to update hidden auto-launch'
            )
          );
        }
      } catch {
        setHideWindowOnAutoLaunch(previous);
        toast.error(
          t(
            'settings.general.autoLaunch.hideWindowToggleFailed',
            'Failed to update hidden auto-launch'
          )
        );
      } finally {
        setPendingOperation(null);
      }
    },
    [hideWindowOnAutoLaunch, isElectron, t, updateStateFromResult]
  );

  const loading = pendingOperation !== null;
  return {
    supported,
    enabled,
    hideWindowOnAutoLaunch,
    loading,
    enabledLoading: pendingOperation === 'read' || pendingOperation === 'enabled',
    hideWindowLoading: pendingOperation === 'read' || pendingOperation === 'hide-window',
    updateEnabled,
    updateHideWindow,
  };
}

import { useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from '@tanstack/react-router';
import { Button } from '@lody/ui/button';
import { pluginCapabilities } from '@lody/shared/plugins/capabilities';
import { useWorkspaceClientPlugins } from './client-host-provider';
import { pluginSafeMode } from './safe-mode';
import { RoutedSurface } from './shell-surfaces';
const idle = () => () => {};
const zero = () => 0;
export function PluginRoute(p: {
  workspaceName: string;
  pluginId: string;
  id: string;
  kind: string;
  machineId?: string;
  projectId?: string;
  params: Record<string, string>;
  target?: object;
}) {
  const owner = useWorkspaceClientPlugins();
  const { t } = useTranslation();
  const [failure, fail] = useState('');
  const revision = useSyncExternalStore(owner?.subscribe ?? idle, owner?.snapshot ?? zero, zero);
  const entry = owner?.routeInstallation(p.pluginId, p.machineId);
  const state = pluginSafeMode()
    ? 'safe_mode'
    : !owner || !revision
      ? 'resolving'
      : !entry
        ? owner.missingRouteState(p.pluginId, p.machineId)
        : !entry.enabled
          ? 'disabled'
          : entry.sourceKey !== 'workspace' && !owner.machineOnline(entry.dev.machineId)
            ? 'source_offline'
            : entry.sourceKey !== 'local' && !owner.trustState(entry)
              ? 'untrusted'
              : 'resolving';
  const fallback = (
    <section role="status">
      {t(
        (
          {
            safe_mode: 'plugins.route.safeMode',
            resolving: 'plugins.route.resolving',
            not_installed: 'plugins.route.notInstalled',
            disabled: 'plugins.route.disabled',
            source_offline: 'plugins.route.sourceOffline',
            untrusted: 'plugins.route.untrusted',
          } as const
        )[state]
      )}
      {state === 'untrusted' && owner && entry && (
        <>
          <p>{pluginCapabilities(entry.dev.manifest).join(', ')}</p>
          <Button
            onClick={() =>
              void (entry.dev.devMode ? owner.trustDev(entry) : owner.trustRelease(entry)).catch(
                (e) => fail(String(e))
              )
            }
          >
            {t('settings.plugins.trust', 'Trust')}
          </Button>
          {failure}
        </>
      )}
      {(state === 'disabled' || state === 'not_installed') && (
        <Link to="/$workspaceName/settings/plugins" params={{ workspaceName: p.workspaceName }}>
          {t('settings.plugins.title', 'Plugins')}
        </Link>
      )}
    </section>
  );
  if (!owner || state !== 'resolving') return fallback;
  return (
    <RoutedSurface
      {...p}
      workspaceId={owner.workspaceId}
      target={
        p.target ??
        (p.projectId
          ? {
              project: {
                workspaceId: owner.workspaceId,
                machineId: p.machineId,
                projectId: p.projectId,
              },
            }
          : {})
      }
      fallback={fallback}
    />
  );
}

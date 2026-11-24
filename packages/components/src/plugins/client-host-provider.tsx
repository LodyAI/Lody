import { clientDiagnostics } from './client-diagnostics';
import { PluginScreenOutlet } from './shell-surfaces';
import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
import { commands } from '../lib/commands/registry';
import { clientPluginEvents } from './client-events';
import type { WorkspaceRef } from '@lody/plugin-sdk';
import { PluginCatalogSubscriber } from './catalog-subscriber';
import {
  createContext,
  useContext,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { ClientPluginHost, type ClientInstallation } from './client-host';
import { pluginSafeMode } from './safe-mode';
import { TrustedDevSessionStore, type DevInstallation } from './trust';

import type { PluginInspection, InspectorAction } from '../components/settings/plugin-inspector';

export interface ClientCatalogInstallation extends ClientInstallation {
  workflowPrompts?: Readonly<Record<string, string>>;
  workflowBinding?: string;
  workflowApproval?: (
    projectId: string,
    action: 'grant' | 'revoke',
    readOperations?: import('@lody/shared/plugins/machine-rpc').WorkflowReadOperation[]
  ) => Promise<number>;
  reserveSession?: import('./client-session-create').ReserveClientSession;
  dev: DevInstallation;
  enabled: boolean;
  inspection?: Omit<PluginInspection, 'manifest' | 'clientDigest' | 'trusted' | 'devSessionNonce'>;
  control?: (
    action: Exclude<InspectorAction, 'approve-dev' | 'approve-release' | 'revoke'>,
    changes?: Record<string, string | number | boolean>
  ) => Promise<NonNullable<ClientCatalogInstallation['inspection']>>;
}
class WorkspaceClientPlugins {
  private readonly host = new ClientPluginHost();
  private readonly leases = new TrustedDevSessionStore();
  private readonly releases = new Set<string>();
  private readonly known = new Map<string, ClientCatalogInstallation>();
  private catalog: readonly ClientCatalogInstallation[] = [];
  private disposed = false;
  private listeners = new Set<() => void>();
  private revision = 0;
  snapshot = () => this.revision;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  installations() {
    return [...this.known.values()];
  }
  trustState(i: ClientCatalogInstallation) {
    return this.leases.allows(i.dev)
      ? 'dev'
      : this.releases.has(this.release(i))
        ? 'release'
        : false;
  }
  revoke(i: ClientCatalogInstallation) {
    this.releases.delete(this.release(i));
    return this.revokeDev(i);
  }
  constructor(readonly workspaceId: string) {}
  private release(i: ClientInstallation) {
    return JSON.stringify([i.workspaceId, i.pluginId, i.digest]);
  }
  async update(entries: readonly ClientCatalogInstallation[]) {
    if (this.disposed) return;
    const safe = pluginSafeMode();
    if (safe) this.leases.clear();
    this.catalog = entries;
    const stale = new Map(this.known);
    const tasks: Promise<void>[] = [];
    for (const i of entries) {
      if (
        i.workspaceId !== this.workspaceId ||
        i.dev.workspaceId !== i.workspaceId ||
        i.dev.manifest.id !== i.pluginId ||
        (i.sourceKey !== 'local' && i.sourceKey !== `machine:${i.dev.machineId}`)
      )
        continue;
      const key = JSON.stringify([i.sourceKey, i.pluginId]);
      stale.delete(key);
      this.known.set(key, i);
      const dev = this.leases.allows(i.dev);
      const trusted = i.sourceKey === 'local' || dev || this.releases.has(this.release(i));
      tasks.push(
        this.host.reconcile(
          i,
          !safe && i.enabled && i.digest && trusted
            ? {
                ...i,
                admissionKey: JSON.stringify([
                  i.dev.machineId,
                  i.dev.owner,
                  i.dev.devMode,
                  i.dev.devSessionNonce,
                  dev,
                ]),
              }
            : null
        )
      );
    }
    for (const [k, i] of stale) {
      this.known.delete(k);
      clientDiagnostics.clear(i);
      this.leases.revoke(i.dev);
      tasks.push(this.host.reconcile(i, null));
    }
    this.revision++;
    this.listeners.forEach((fn) => fn());
    await Promise.all(tasks);
  }
  trustRelease(i: ClientCatalogInstallation) {
    if (!this.catalog.includes(i)) throw Error('Stale installation');
    this.releases.add(this.release(i));
    return this.update(this.catalog);
  }
  trustDev(i: ClientCatalogInstallation) {
    const current = this.known.get(JSON.stringify([i.sourceKey, i.pluginId]));
    if (
      !current ||
      current.workspaceId !== i.workspaceId ||
      current.dev.machineId !== i.dev.machineId ||
      current.digest !== i.digest ||
      current.dev.devSessionNonce !== i.dev.devSessionNonce ||
      JSON.stringify(current.dev.manifest) !== JSON.stringify(i.dev.manifest)
    )
      throw Error('Stale installation');
    this.leases.grant(current.dev);
    return this.update(this.catalog);
  }
  revokeDev(i: ClientCatalogInstallation) {
    this.leases.revoke(i.dev);
    return this.update(this.catalog);
  }
  async close() {
    this.disposed = true;
    this.leases.clear();
    this.releases.clear();
    this.catalog = [];
    const tasks = [...this.known.values()].map((i) => this.host.reconcile(i, null));
    this.known.forEach((i) => clientDiagnostics.clear(i));
    this.known.clear();
    await Promise.all(tasks);
  }
}
function TrustedDevIndicator({ owner }: { owner: WorkspaceClientPlugins }) {
  useSyncExternalStore(owner.subscribe, owner.snapshot, owner.snapshot);
  const { t } = useTranslation();
  const [failure, setFailure] = useState('');
  return (
    <>
      {owner
        .installations()
        .filter((i) => owner.trustState(i) === 'dev')
        .map((i) => (
          <aside key={JSON.stringify([i.sourceKey, i.pluginId])}>
            {i.dev.manifest.title} ({i.dev.machineId}) · {t('settings.plugins.hmr')} ·{' '}
            <Button
              variant="secondary"
              size="small"
              onClick={() => {
                void owner.revoke(i).catch(() => setFailure(t('settings.plugins.cleanupFailed')));
              }}
            >
              {t('settings.plugins.revoke')}
            </Button>
          </aside>
        ))}
      {failure && <p role="alert">{failure}</p>}
    </>
  );
}
const Context = createContext<WorkspaceClientPlugins | null>(null);
export const useWorkspaceClientPlugins = () => useContext(Context);
export function ClientPluginHostProvider({
  admission,
  children,
}: {
  admission: { workspaceId: string; signal: AbortSignal } | null;
  children: ReactNode;
}) {
  const [binding, setBinding] = useState<{
    admission: NonNullable<typeof admission>;
    owner: WorkspaceClientPlugins;
  } | null>(null);
  useLayoutEffect(() => {
    if (!admission || admission.signal.aborted) return;
    const { workspaceId, signal } = admission;
    const owner = new WorkspaceClientPlugins(workspaceId);
    const subscriptions = new AbortController();
    const close = () => {
      if (subscriptions.signal.aborted) return;
      subscriptions.abort();
      void owner.close().catch((error) => console.error('Plugin cleanup failed', error));
      setBinding(null);
    };
    commands.onInvoked(
      (commandId) =>
        clientPluginEvents.publish('ui.command.invoked', {
          workspace: { workspaceId } as WorkspaceRef,
          commandId,
        }),
      subscriptions.signal
    );
    signal.addEventListener('abort', close, { once: true });
    setBinding({ admission, owner });
    return () => {
      signal.removeEventListener('abort', close);
      close();
    };
  }, [admission]);
  const owner =
    binding && binding.admission === admission && !admission.signal.aborted ? binding.owner : null;
  return (
    <Context.Provider value={owner}>
      {owner && (
        <>
          <TrustedDevIndicator owner={owner} />
          <PluginCatalogSubscriber />
          <PluginScreenOutlet workspaceId={owner.workspaceId} />
        </>
      )}
      {children}
    </Context.Provider>
  );
}

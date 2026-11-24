import {
  workspaceOnly,
  workspacePage,
  workspaceReleaseStore,
  captureRelease,
  clientPreferenceChanges,
  type WorkspaceRelease,
} from './workspace-installations';
import { comparePluginVersions } from '@lody/shared/plugins/manifest-schema';
import { getIpcServices } from '../lib/electron-ipc-client';
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
  invalidations?: number;
  packageSha256?: string;
  configureClient?: (changes: Record<string, string | number | boolean>) => Promise<void>;
  workflowPrompts?: Readonly<Record<string, string>>;
  declaredGrant?: Omit<
    import('@lody/shared/plugins/machine-rpc').DeclaredWorkflowGrant,
    'signature'
  >;
  workflowBinding?: string;
  workflowApproval?: (
    projectId: string,
    action: 'grant' | 'revoke',
    roleIds: string[] | '*',
    operations: import('@lody/shared/plugins/machine-rpc').DeclaredWorkflowGrant['allowed_ops']
  ) => Promise<void>;
  reserveSession?: import('./client-session-create').ReserveClientSession;
  dev: DevInstallation;
  enabled: boolean;
  inspection?: Omit<PluginInspection, 'manifest' | 'clientDigest' | 'trusted' | 'devSessionNonce'>;
  control?: (
    action: Exclude<InspectorAction, 'approve-dev' | 'approve-release' | 'revoke'>,
    changes?: Record<string, string | number | boolean>,
    projectId?: string
  ) => Promise<NonNullable<ClientCatalogInstallation['inspection']>>;
}
export class WorkspaceClientPlugins {
  private readonly host = new ClientPluginHost();
  private readonly leases = new TrustedDevSessionStore();
  private readonly releases = new Set<string>();
  private readonly known = new Map<string, ClientCatalogInstallation>();
  private catalog: readonly ClientCatalogInstallation[] = [];
  private disposed = false;
  private lifetime = new AbortController();
  private records = new Map<string, WorkspaceRelease>();
  private store?: ReturnType<typeof workspaceReleaseStore>;
  private database() {
    return (this.store ??= workspaceReleaseStore(this.storageNamespace, this.lifetime.signal));
  }
  private makeRegistry?: (entry: ClientCatalogInstallation) => ClientInstallation['registry'];
  async restore(make: (entry: ClientCatalogInstallation) => ClientInstallation['registry']) {
    this.makeRegistry = make;
    const rows = await (await this.database()).list();
    this.lifetime.signal.throwIfAborted();
    this.records = new Map(rows.map((r) => [r.manifest.id, r]));
    await this.update(this.catalog);
  }
  private workspaceEntry(row: WorkspaceRelease): ClientCatalogInstallation {
    const inspection = {
      lifecycle: 'active',
      preferences: row.preferences,
      configured: Object.keys(row.preferences),
      registrations: [],
      logs: [],
      diagnostics: [],
    };
    const entry: ClientCatalogInstallation = {
      workspaceId: this.workspaceId,
      sourceKey: 'workspace',
      machineId: row.origin,
      localModule: row.local,
      workspaceManifest: row.manifest,
      pluginId: row.manifest.id,
      digest: row.digest,
      client: row.manifest.client,
      enabled: true,
      dev: {
        workspaceId: this.workspaceId,
        machineId: row.origin,
        owner: false,
        devMode: false,
        manifest: row.manifest,
      },
      inspection,
      configurationKey: JSON.stringify(row.preferences),
      page: workspacePage(row),
      registry: (...args) => this.makeRegistry!(entry)(...args),
      configureClient: async (changes) => {
        if (this.records.get(entry.pluginId) !== row || pluginSafeMode())
          throw Error('Stale installation');
        const next = {
          ...row,
          preferences: { ...row.preferences, ...clientPreferenceChanges(row.manifest, changes) },
        };
        this.records.set(entry.pluginId, next);
        try {
          await (await this.database()).put(next);
        } catch (e) {
          if (this.records.get(entry.pluginId) === next) this.records.set(entry.pluginId, row);
          throw e;
        }
        await this.update(this.catalog);
      },
    };
    return entry;
  }
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
    if (i.sourceKey === 'workspace') return 'release';
    return this.leases.allows(i.dev)
      ? 'dev'
      : this.releases.has(this.release(i))
        ? 'release'
        : false;
  }
  async revoke(i: ClientCatalogInstallation) {
    if (i.sourceKey === 'workspace') {
      if (this.records.get(i.pluginId)?.digest !== i.digest) throw Error('Stale installation');
      await this.nativeProof(i, 'forget');
      await (await this.database()).remove(i.pluginId);
      this.records.delete(i.pluginId);
      return this.update(this.catalog);
    }
    this.releases.delete(this.release(i));
    return this.revokeDev(i);
  }
  constructor(
    readonly workspaceId: string,
    readonly storageNamespace: string
  ) {}
  private async nativeProof(i: ClientCatalogInstallation, action: 'approve' | 'forget') {
    const ipc = getIpcServices();
    if (!ipc || !i.dev.manifest.client) return;
    const service = i.sourceKey === 'local' || i.localModule ? ipc.machineRpc : ipc.e2ee;
    await service.workspacePluginModule(
      this.workspaceId,
      i.dev.machineId,
      i.dev.manifest,
      i.digest,
      { action }
    );
  }
  private release(i: ClientInstallation) {
    return JSON.stringify([i.workspaceId, i.sourceKey, i.pluginId, i.digest]);
  }
  async update(entries: readonly ClientCatalogInstallation[]) {
    if (this.disposed) return;
    const safe = pluginSafeMode();
    if (safe) this.leases.clear();
    this.catalog = entries;
    const stale = new Map(this.known);
    const tasks: Promise<void>[] = [];
    const candidates = [
      ...entries.filter(
        (i) =>
          i.workspaceId === this.workspaceId &&
          i.dev.workspaceId === this.workspaceId &&
          i.dev.manifest.id === i.pluginId &&
          (i.sourceKey === 'local' || i.sourceKey === `machine:${i.dev.machineId}`) &&
          !(
            workspaceOnly(i.dev.manifest) &&
            !i.dev.devMode &&
            this.records.get(i.pluginId)?.digest === i.digest
          )
      ),
      ...Array.from(this.records.values(), (r) => this.workspaceEntry(r)),
    ];
    const eligible = (i: ClientCatalogInstallation) =>
      i.enabled &&
      i.digest &&
      (i.sourceKey === 'workspace' ||
        ((!workspaceOnly(i.dev.manifest) || i.dev.devMode) &&
          (i.sourceKey === 'local' || !!this.trustState(i))));
    const winners = new Map<string, ClientCatalogInstallation>();
    for (const i of candidates.filter(eligible)) {
      const prev = winners.get(i.pluginId);
      if (
        !prev ||
        comparePluginVersions(i.dev.manifest.version, prev.dev.manifest.version) > 0 ||
        (comparePluginVersions(i.dev.manifest.version, prev.dev.manifest.version) === 0 &&
          i.sourceKey < prev.sourceKey)
      )
        winners.set(i.pluginId, i);
    }
    for (const i of candidates) {
      if (
        i.workspaceId !== this.workspaceId ||
        i.dev.workspaceId !== i.workspaceId ||
        i.dev.manifest.id !== i.pluginId ||
        (i.sourceKey !== 'workspace' &&
          i.sourceKey !== 'local' &&
          i.sourceKey !== `machine:${i.dev.machineId}`)
      )
        continue;
      const key = JSON.stringify([i.sourceKey, i.pluginId]);
      stale.delete(key);
      this.known.set(key, i);
      const dev = this.leases.allows(i.dev);
      const primary = winners.get(i.pluginId) === i;
      tasks.push(
        this.host.reconcile(
          i,
          !safe && eligible(i)
            ? {
                ...i,
                primary,
                admissionKey: JSON.stringify([
                  primary,
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
  async trustRelease(i: ClientCatalogInstallation) {
    if (!this.catalog.includes(i)) throw Error('Stale installation');
    if (pluginSafeMode()) throw Error('Plugins disabled in safe mode');
    if (workspaceOnly(i.dev.manifest) && !i.dev.devMode) {
      const r = await captureRelease(i, this.lifetime.signal);
      if (
        !this.catalog.some(
          (c) =>
            c.pluginId === i.pluginId &&
            c.sourceKey === i.sourceKey &&
            c.enabled &&
            JSON.stringify(c.dev) === JSON.stringify(i.dev) &&
            c.digest === i.digest
        )
      )
        throw Error('Stale installation');
      await this.nativeProof(i, 'approve');
      this.lifetime.signal.throwIfAborted();
      await (await this.database()).put(r);
      this.records.set(i.pluginId, r);
      return this.update(this.catalog);
    }
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
    this.lifetime.abort();
    this.records.clear();
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
  admission: { storageNamespace: string; workspaceId: string; signal: AbortSignal } | null;
  children: ReactNode;
}) {
  const [binding, setBinding] = useState<{
    admission: NonNullable<typeof admission>;
    owner: WorkspaceClientPlugins;
  } | null>(null);
  useLayoutEffect(() => {
    if (!admission || admission.signal.aborted) return;
    const { workspaceId, signal } = admission;
    const owner = new WorkspaceClientPlugins(workspaceId, admission.storageNamespace);
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

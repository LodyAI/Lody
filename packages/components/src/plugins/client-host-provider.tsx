import { ownerSyncCustody } from './owner-sync-custody';
import { getIpcServices } from '../lib/electron-ipc-client';
import { isLocalAppPlatform } from '../lib/app-platform';
import { projectPluginValues, type WorkspaceFlockScanRow } from '@lody/shared';
import { PluginSecretEditorProvider } from './settings-fields';
import type { WorkspacePluginEntry } from '@lody/shared/plugins/workspace-entry';
import {
  fetchWorkspaceNpmRelease,
  NpmTransportUnavailable,
} from '@lody/shared/plugins/workspace-npm';
import {
  workspacePage,
  workspaceReleaseStore,
  fetchPinnedMachineBundle,
  type WorkspaceRelease,
} from './workspace-installations';
import { comparePluginVersions } from '@lody/shared/plugins/manifest-schema';
import { clientDiagnostics } from './client-diagnostics';
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
  readProject?: (
    machine: string,
    project: string
  ) => Record<string, string | number | boolean> | undefined;
  projectValues?: PluginInspection['projectValues'];
  npm?: WorkspacePluginEntry;
  invalidations?: number;
  machinePort?: import('./query-bindings').PluginCallPort;
  source?: import('@lody/shared/plugins/workspace-entry').PluginInstallationSource;
  packageSha256?: string;
  configureProject?: (
    machineId: string,
    projectId: string,
    changes: Record<string, string | number | boolean>
  ) => Promise<void>;
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
  setSecret?: (fieldKey: string, value: string) => Promise<void>;
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
  projectWriter?: (
    entry: ClientCatalogInstallation,
    machine: string,
    project: string,
    changes: Record<string, string | number | boolean>
  ) => Promise<void>;
  private projectRows: WorkspaceFlockScanRow[] = [];
  setProjectRows(rows: WorkspaceFlockScanRow[]) {
    this.projectRows = rows;
    return this.update(this.catalog);
  }
  private npmRows: readonly WorkspacePluginEntry[] = [];
  setWorkspacePlugins(rows: readonly WorkspacePluginEntry[]) {
    this.npmRows = rows;
    return this.update(this.catalog);
  }
  private currentNpm(row: WorkspacePluginEntry) {
    return this.npmRows.some((r) => r.enabled && JSON.stringify(r) === JSON.stringify(row));
  }
  private approvedNpm(row: WorkspacePluginEntry) {
    const cached = this.records.get(row.plugin_id);
    return (
      cached?.npm &&
      cached.digest === row.client_digest &&
      JSON.stringify(cached.manifest) === JSON.stringify(row.manifest_summary) &&
      JSON.stringify(cached.npm) === JSON.stringify(row)
    );
  }
  private database() {
    return (this.store ??= workspaceReleaseStore(
      this.storageNamespace,
      this.lifetime.signal,
      () => {
        if (this.makeRegistry)
          void this.restore(this.makeRegistry).catch((e) => {
            if (!this.disposed) console.error('Plugin cache refresh failed', e);
          });
      }
    ));
  }
  private makeRegistry?: (entry: ClientCatalogInstallation) => ClientInstallation['registry'];
  async restore(make: (entry: ClientCatalogInstallation) => ClientInstallation['registry']) {
    this.makeRegistry = make;
    const db = await this.database();
    const [rows, sources] = await Promise.all([db.list(), db.catalogSources()]);
    this.sources = new Map(sources.map((s) => [s.machine, s.plugins]));
    this.lifetime.signal.throwIfAborted();
    this.records = new Map(rows.filter((r) => r.npm).map((r) => [r.manifest.id, r]));
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
    const projectRows = this.projectRows.filter(
      (r) => r.key[2] === row.manifest.id && r.key.length === 4
    );
    const projects = new Map(
      projectRows.flatMap((r) => {
        try {
          return [
            [
              JSON.stringify([r.key[1], r.key[3]]),
              projectPluginValues(row.manifest, r.value),
            ] as const,
          ];
        } catch {
          return [];
        }
      })
    );
    const entry: ClientCatalogInstallation = {
      readProject: (machine, project) => projects.get(JSON.stringify([machine, project])),
      npm: row.npm,
      source: row.npm?.source,
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
      configurationKey: JSON.stringify([row.preferences, ...projects]),
      page: workspacePage(row),
      registry: (...args) => this.makeRegistry!(entry)(...args),
      configureClient: async (changes) => {
        if (this.records.get(entry.pluginId) !== row || pluginSafeMode())
          throw Error('Stale installation');
        const next = await (await this.database()).configure(row, changes);
        this.records.set(entry.pluginId, next);
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
  routeInstallation(plugin: string, machine?: string) {
    const candidates = this.installations().filter(
      (i) =>
        i.pluginId === plugin &&
        (!machine || i.sourceKey === 'workspace' || i.dev.machineId === machine)
    );
    const admitted = candidates.filter(
      (i) =>
        i.enabled &&
        (i.sourceKey === 'workspace' || this.machineOnline(i.dev.machineId)) &&
        (i.sourceKey === 'local' || this.trustState(i))
    );
    return (
      admitted.sort(
        (a, b) =>
          comparePluginVersions(b.dev.manifest.version, a.dev.manifest.version) ||
          (a.sourceKey < b.sourceKey ? -1 : 1)
      )[0] ??
      candidates.find((i) => i.sourceKey === 'workspace') ??
      candidates[0]
    );
  }
  private sources = new Map<string, string[]>();
  private catalogReady = false;
  finishCatalogPoll() {
    if (!this.catalogReady) {
      this.catalogReady = true;
      this.revision++;
      this.listeners.forEach((fn) => fn());
    }
  }
  missingRouteState(plugin: string, machine?: string) {
    if (!this.catalogReady) return 'resolving';
    for (const [id, plugins] of this.sources)
      if ((!machine || machine === id) && !this.online.has(id) && plugins.includes(plugin))
        return 'source_offline';
    return 'not_installed';
  }
  async rememberCatalog(machine: string, entries: readonly ClientCatalogInstallation[]) {
    const plugins = entries
      .filter((e) => e.source?.kind === 'local')
      .map((e) => e.pluginId)
      .sort();
    if (JSON.stringify(this.sources.get(machine) ?? []) === JSON.stringify(plugins)) return;
    this.sources.set(machine, plugins);
    await (await this.database()).saveCatalogSources(machine, plugins);
  }
  private online = new Set<string>();
  setOnlineMachines(ids: readonly string[]) {
    this.online = new Set(ids);
  }
  machineOnline(id: string) {
    return this.online.has(id);
  }
  resolveMachine(pluginId: string, machineId: string) {
    if (this.disposed || pluginSafeMode())
      throw Object.assign(Error('Plugin disabled'), { code: 'forbidden' });
    if (!this.online.has(machineId))
      throw Object.assign(Error('Machine offline'), { code: 'machine_offline' });
    const target = this.catalog.find(
      (i) =>
        i.workspaceId === this.workspaceId &&
        i.pluginId === pluginId &&
        i.dev.machineId === machineId &&
        i.enabled
    );
    if (!target)
      throw Object.assign(Error('Plugin not enabled on target machine'), { code: 'not_found' });
    if (target.sourceKey !== 'local' && !this.trustState(target))
      throw Object.assign(Error('Target installation is untrusted'), { code: 'forbidden' });
    return target;
  }
  trustState(i: ClientCatalogInstallation) {
    if (i.sourceKey === 'workspace') return i.npm && this.approvedNpm(i.npm) ? 'release' : false;
    return this.leases.allows(i.dev)
      ? 'dev'
      : this.releases.has(this.release(i))
        ? 'release'
        : false;
  }
  async revoke(i: ClientCatalogInstallation) {
    if (i.sourceKey === 'workspace') {
      if (this.records.get(i.pluginId)?.digest !== i.digest) throw Error('Stale installation');
      const cached = this.records.get(i.pluginId)!;
      await this.nativeProof(cached, { action: 'forget' });
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
  ) {
    this.ownerSync = ownerSyncCustody(storageNamespace, this.lifetime.signal);
  }
  readonly ownerSync: ReturnType<typeof ownerSyncCustody>;
  private async nativeProof(
    row: WorkspaceRelease,
    op: { action: 'forget' } | { action: 'approve'; npm?: WorkspacePluginEntry }
  ) {
    const ipc = getIpcServices();
    if (!ipc || !row.manifest.client) return;
    await (row.local ? ipc.machineRpc : ipc.e2ee).workspacePluginModule(
      this.workspaceId,
      row.origin,
      row.manifest,
      row.digest,
      op
    );
  }
  registry = 'https://registry.npmjs.org/';
  private release(i: ClientCatalogInstallation) {
    return JSON.stringify([i.workspaceId, i.sourceKey, i.pluginId, i.digest, i.dev.manifest]);
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
          (i.sourceKey === 'local' || i.sourceKey === `machine:${i.dev.machineId}`)
      ),
      ...this.npmRows
        .filter((n) => !!n.client_digest)
        .map((n) => {
          const approved = this.approvedNpm(n);
          const row = approved
            ? this.records.get(n.plugin_id)!
            : {
                manifest: n.manifest_summary,
                digest: n.client_digest!,
                bytes: new Uint8Array(),
                local: false,
                origin: 'workspace',
                preferences: {},
                npm: n,
              };
          const e = this.workspaceEntry(row);
          e.enabled = n.enabled;
          if (!approved) delete e.configureClient;
          return e;
        }),
    ];
    const eligible = (i: ClientCatalogInstallation) =>
      i.enabled &&
      i.digest &&
      ((i.sourceKey === 'workspace' && !!this.trustState(i)) ||
        (i.sourceKey !== 'workspace' && (i.sourceKey === 'local' || !!this.trustState(i))));
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
    const targetRevisions = new Map<string, string[]>();
    for (const target of entries) {
      if (!eligible(target) || target.workspaceId !== this.workspaceId) continue;
      const group = targetRevisions.get(target.pluginId) ?? [];
      group.push(JSON.stringify([target.sourceKey, target.digest, target.invalidations ?? 0]));
      targetRevisions.set(target.pluginId, group);
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
      i.configureProject = async (machine, project, changes) => {
        if (
          !this.projectWriter ||
          this.disposed ||
          pluginSafeMode() ||
          this.known.get(JSON.stringify([i.sourceKey, i.pluginId]))?.digest !== i.digest ||
          (i.sourceKey === 'workspace'
            ? !i.npm || !this.approvedNpm(i.npm)
            : machine !== i.machineId)
        )
          throw Error('Project configuration unavailable');
        await this.projectWriter(i, machine, project, changes);
      };
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
                invalidations: primary
                  ? JSON.stringify(targetRevisions.get(i.pluginId)?.sort() ?? [])
                  : i.invalidations,
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
    if (i.npm) {
      const n = i.npm;
      if (!this.currentNpm(n) || !n.client_digest || pluginSafeMode())
        throw Error('Stale or disabled workspace release');
      let r: WorkspaceRelease;
      let fallback: ClientCatalogInstallation | undefined;
      try {
        r = await fetchWorkspaceNpmRelease(n, this.lifetime.signal, this.registry);
      } catch (error) {
        if (!(error instanceof NpmTransportUnavailable)) throw error;
        const fallbacks = this.catalog.filter(
          (c) =>
            c.enabled &&
            !c.dev.devMode &&
            c.pluginId === n.plugin_id &&
            c.digest === n.client_digest &&
            JSON.stringify(c.dev.manifest) === JSON.stringify(n.manifest_summary)
        );
        let recovered: WorkspaceRelease | undefined;
        let last: unknown = error;
        for (const candidate of fallbacks) {
          if (!this.currentNpm(n) || pluginSafeMode()) throw Error('Approval no longer current');
          this.lifetime.signal.throwIfAborted();
          try {
            recovered = await fetchPinnedMachineBundle(n, candidate, this.lifetime.signal);
            fallback = candidate;
            break;
          } catch (e) {
            last = e;
          }
        }
        if (!recovered) throw last;
        r = recovered;
      }
      if (
        r.digest !== n.client_digest ||
        JSON.stringify(r.manifest) !== JSON.stringify(n.manifest_summary) ||
        !this.currentNpm(n) ||
        pluginSafeMode()
      )
        throw Error('Workspace release no longer matches approval');
      const ipc = getIpcServices();
      const local = fallback ? fallback.sourceKey === 'local' : !!ipc && isLocalAppPlatform();
      const origin = fallback?.dev.machineId ?? 'workspace';
      r = { ...r, npm: n, origin, local, preferences: {} };
      await this.nativeProof(r, fallback ? { action: 'approve' } : { action: 'approve', npm: n });
      if (!this.currentNpm(n) || pluginSafeMode() || this.lifetime.signal.aborted) {
        await this.nativeProof(r, { action: 'forget' });
        throw Error('Approval no longer current');
      }
      try {
        await (await this.database()).put(r);
      } catch (error) {
        await this.nativeProof(r, { action: 'forget' });
        throw error;
      }
      this.records.set(n.plugin_id, r);
      return this.update(this.catalog);
    }
    if (!this.catalog.includes(i)) throw Error('Stale installation');
    if (pluginSafeMode()) throw Error('Plugins disabled in safe mode');
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
      <PluginSecretEditorProvider>
        {owner && (
          <>
            <TrustedDevIndicator owner={owner} />
            <PluginCatalogSubscriber />
          </>
        )}
        {children}
      </PluginSecretEditorProvider>
    </Context.Provider>
  );
}

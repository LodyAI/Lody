import { rendererFlockGroupSchema } from '@lody/shared/renderer-flock-room-group';
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MachineCatalogError,
  getMachineFlockDocId,
  type MachineCatalogBinding,
  type MachineId,
  type WorkspaceId,
} from '@lody/shared';
import { isLocalUserId, isLocalWorkspaceId } from '@lody/shared/platform-kind';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import { resolveLocalIndependentRepo } from '@lody/shared/node/native-repo-independent-paths';
import { IndependentNativeRepoHostLegacy } from '@lody/shared/node/native-repo-independent-legacy';
import { loadNativeRepoSdkCompatibility } from '@lody/shared/node/native-repo-sdk-compatibility';
import type { RepoClient } from '@loro-dev/loro-repo-client';
import { getCliNodeExecutable } from '../managed-daemon-release';
import { toShared } from '@/platform/process-options';
import { createNativeMachineRuntimePorts } from './native-machine-catalog';
import type { MachineDocumentRuntimePort } from '../machine-document-runtime-port';
import type { ProviderSetupStoragePort } from '../provider-setup-manager';

type Ports = ReturnType<typeof createNativeMachineRuntimePorts>;
const rootFor = () => getLodyDataDir('local');
/** One-shot consumers select the same complete MF owner as the daemon.
 * This first product batch admits one trusted machine, never a family subset. */
export function readSelectedLocalMachineCatalogId(options: {
  accountId: string;
  workspaceId: string;
  dataRoot?: string;
}): MachineId | undefined {
  if (!isLocalUserId(options.accountId) || !isLocalWorkspaceId(options.workspaceId))
    return undefined;
  const dataRoot = options.dataRoot ?? rootFor();
  const file = join(dataRoot, 'native-repo', 'renderer-flock-group-owners.sqlite3');
  if (existsSync(file)) {
    const db = new Database(file, { readonly: true, fileMustExist: true, timeout: 0 });
    try {
      const prefix =
        JSON.stringify([options.accountId, options.workspaceId, 'machine', 'plaintext']).slice(
          0,
          -1
        ) + ',';
      const rows = db
        .prepare('SELECT group_json FROM renderer_flock_group_owners WHERE instr(scope,?)=1')
        .all(prefix) as Array<{
        group_json: string;
      }>;
      const groups = rows
        .map((row) => rendererFlockGroupSchema.parse(JSON.parse(row.group_json)))
        .filter(
          (group) =>
            group.domain === 'machine' &&
            group.accountId === options.accountId &&
            group.workspaceId === options.workspaceId
        );
      if (groups.length) {
        if (groups.length !== 1 || groups[0]!.roomIds.length !== 1)
          throw new Error('MF room dispatcher requires explicit recovery');
        return groups[0]!.roomIds[0]!.slice(`${options.workspaceId}:mf:`.length) as MachineId;
      }
    } finally {
      db.close();
    }
  }
  const descriptor = resolveLocalIndependentRepo({ platform: 'local', ...options, dataRoot });
  const routes = join(descriptor.directory, 'routes.sqlite3');
  if (existsSync(routes)) {
    const db = new Database(routes, { readonly: true, fileMustExist: true, timeout: 0 });
    try {
      const binding = JSON.stringify([options.accountId, options.workspaceId]);
      const rows = db
        .prepare(
          "SELECT room_key FROM native_room_migrations WHERE binding=? AND stage!='legacy' UNION SELECT room_key FROM native_room_maintenance WHERE binding=?"
        )
        .all(binding, binding) as Array<{ room_key: string }>;
      for (const row of rows) {
        const room: unknown = JSON.parse(row.room_key);
        if (
          room &&
          typeof room === 'object' &&
          'id' in room &&
          typeof room.id === 'string' &&
          room.id.startsWith(`${options.workspaceId}:mf:`)
        )
          throw new Error('MF group witness missing; legacy fallback is forbidden');
      }
    } finally {
      db.close();
    }
  }
  return undefined;
}

/** Read-only persistent selection; a main freeze is binding before native import. */
export function readLocalMachineCatalogOwner(options: {
  dataRoot: string;
  accountId: string;
  workspaceId: string;
  machineId: string;
}): 'legacy' | 'frozen' | 'native' {
  const roomId = getMachineFlockDocId(
    options.workspaceId as WorkspaceId,
    options.machineId as MachineId
  );
  const selected = resolveLocalIndependentRepo({ platform: 'local', ...options });
  let main: 'legacy' | 'frozen' | 'native' = 'legacy';
  const mainFile = join(options.dataRoot, 'native-repo', 'renderer-flock-group-owners.sqlite3');
  if (existsSync(mainFile)) {
    const db = new Database(mainFile, { readonly: true, fileMustExist: true, timeout: 0 });
    try {
      const row = db
        .prepare(
          `SELECT o.owner FROM renderer_flock_group_rooms r JOIN renderer_flock_group_owners o ON o.scope=r.group_scope WHERE r.binding=? AND r.room_id=?`
        )
        .get(JSON.stringify([options.accountId, options.workspaceId, 'plaintext']), roomId) as
        | { owner: string }
        | undefined;
      if (row) {
        if (row.owner !== 'frozen' && row.owner !== 'native')
          throw new Error('Unsupported MF group owner');
        main = row.owner;
      }
    } finally {
      db.close();
    }
  }
  const file = join(selected.directory, 'routes.sqlite3');
  if (!existsSync(file)) return main === 'native' ? 'frozen' : main;
  const db = new Database(file, { readonly: true, fileMustExist: true, timeout: 0 });
  try {
    return db.transaction(() => {
      const binding = JSON.stringify([options.accountId, options.workspaceId]);
      const key = JSON.stringify({ kind: 'flock', id: roomId });
      if (
        main === 'frozen' ||
        db
          .prepare('SELECT 1 FROM native_room_maintenance WHERE binding=? AND room_key=?')
          .get(binding, key)
      )
        return 'frozen' as const;
      const row = db
        .prepare('SELECT stage FROM native_room_migrations WHERE binding=? AND room_key=?')
        .get(binding, key) as { stage: string } | undefined;
      if (!row || row.stage === 'legacy')
        return main === 'native' ? ('frozen' as const) : ('legacy' as const);
      if (row.stage === 'native') return 'native' as const;
      if (row.stage === 'frozen' || row.stage === 'verified') return 'frozen' as const;
      throw new Error('Unsupported MF migration stage');
    })();
  } finally {
    db.close();
  }
}
export function isLegacyLocalMachineCatalogCurrent(
  accountId: string,
  workspaceId: WorkspaceId,
  machineId: MachineId
): boolean {
  return (
    !isLocalUserId(accountId) ||
    !isLocalWorkspaceId(workspaceId) ||
    readLocalMachineCatalogOwner({ dataRoot: rootFor(), accountId, workspaceId, machineId }) ===
      'legacy'
  );
}
function assertStorage(options: {
  dataRoot: string;
  accountId: string;
  workspaceId: WorkspaceId;
  machineId: MachineId;
}): void {
  const selected = resolveLocalIndependentRepo({ platform: 'local', ...options });
  const db = new Database(
    join(
      selected.dataDir,
      'namespaces',
      `ns_${Buffer.from(options.workspaceId).toString('hex')}.sqlite3`
    ),
    { readonly: true, fileMustExist: true, timeout: 0 }
  );
  try {
    const schema = db.prepare("SELECT v FROM v2_meta WHERE k='schema_version'").get() as
      | { v: number }
      | undefined;
    const row = db
      .prepare('SELECT encryption FROM v2_rooms WHERE room_kind=2 AND room_id=?')
      .get(getMachineFlockDocId(options.workspaceId, options.machineId)) as
      | { encryption: number }
      | undefined;
    if (schema?.v !== 1 || row?.encryption !== 0)
      throw new Error('Published MF storage requires recovery');
  } finally {
    db.close();
  }
}
/** Local domain composition, never an IPC endpoint. Exact generations share one
 * independent lease; mutations are never replayed onto a replacement client. */
export class NativeLocalMachineCatalogLegacy {
  readonly binding: MachineCatalogBinding;
  readonly execution: MachineDocumentRuntimePort;
  readonly providerSetup: ProviderSetupStoragePort;
  readonly catalog: Ports['catalog'];
  private readonly host: IndependentNativeRepoHostLegacy;
  private current: { client: RepoClient; ports: Ports } | undefined;
  private acquiring: Promise<Ports> | undefined;
  private closed = false;
  private readonly observers = new Set<{ close(): void; cleanup(): Promise<void> }>();
  private closing: Promise<void> | undefined;
  constructor(
    private readonly options: {
      accountId: string;
      workspaceId: WorkspaceId;
      machineId: MachineId;
      dataRoot: string;
      requiredSdkArtifactId: string;
      launch?: { executable: string; entry: string };
    }
  ) {
    this.binding = Object.freeze({
      accountId: options.accountId,
      workspaceId: options.workspaceId,
      machineId: options.machineId,
    });
    const selected = resolveLocalIndependentRepo({ platform: 'local', ...options });
    this.host = new IndependentNativeRepoHostLegacy(
      {
        dataDir: selected.dataDir,
        binding: selected.binding,
        requiredSdkArtifactId: options.requiredSdkArtifactId,
        ...(options.launch ?? {
          executable: getCliNodeExecutable(),
          entry: join(dirname(fileURLToPath(import.meta.url)), 'native-repo-independent-host.js'),
        }),
      },
      toShared()
    );
    this.execution = {
      binding: this.binding,
      close: () => this.retire(),
      hasAgentConfig: (...args) => this.request((ports) => ports.execution.hasAgentConfig(...args)),
      findSoleAgentConfig: (...args) =>
        this.request((ports) => ports.execution.findSoleAgentConfig(...args)),
      getBuiltinAgentOptOuts: (...args) =>
        this.request((ports) => ports.execution.getBuiltinAgentOptOuts(...args)),
      getAgentConfigById: (...args) =>
        this.request((ports) => ports.execution.getAgentConfigById(...args)),
      getAgentConfigForMachineLaunch: (...args) =>
        this.request((ports) => ports.execution.getAgentConfigForMachineLaunch(...args)),
      createAgentConfig: (...args) =>
        this.request((ports) => ports.execution.createAgentConfig(...args)),
      updateRateLimits: (...args) =>
        this.request((ports) => ports.execution.updateRateLimits(...args)),
      updateAcpCapabilities: (...args) =>
        this.request((ports) => ports.execution.updateAcpCapabilities(...args)),
      updateAcpAuthMethods: (...args) =>
        this.request((ports) => ports.execution.updateAcpAuthMethods(...args)),
      getAcpCapabilities: (...args) =>
        this.request((ports) => ports.execution.getAcpCapabilities(...args)),
      readSessionLaunchSnapshot: (...args) =>
        this.request((ports) => ports.execution.readSessionLaunchSnapshot(...args)),
      readAgentConfigs: (...args) =>
        this.request((ports) => ports.execution.readAgentConfigs(...args)),
      readAgentConfig: (...args) =>
        this.request((ports) => ports.execution.readAgentConfig(...args)),
      saveAgentConfig: (...args) =>
        this.request((ports) => ports.execution.saveAgentConfig(...args)),
      removeAgentConfig: (...args) =>
        this.request((ports) => ports.execution.removeAgentConfig(...args)),
      readCatalog: (...args) => this.request((ports) => ports.execution.readCatalog(...args)),
      saveLocalProject: (...args) =>
        this.request((ports) => ports.execution.saveLocalProject(...args)),
      removeLocalProject: (...args) =>
        this.request((ports) => ports.execution.removeLocalProject(...args)),
      importMagpie: (...args) => this.request((ports) => ports.execution.importMagpie(...args)),
      upload: (...args) => this.request((ports) => ports.execution.upload(...args)),
    };
    this.providerSetup = {
      signal: () => this.current?.ports.providerSetup.signal() ?? AbortSignal.abort(),
      observe: (listener, onError) =>
        this.observe(
          async (ports, failed) => ports.providerSetup.observe(listener, failed),
          onError
        ),
      read: () => this.request((ports) => ports.providerSetup.read()),
      reconcileCancellations: () =>
        this.request((ports) => ports.providerSetup.reconcileCancellations()),
      replace: (...args) => this.request((ports) => ports.providerSetup.replace(...args)),
      remove: (...args) => this.request((ports) => ports.providerSetup.remove(...args)),
      publish: (...args) => this.request((ports) => ports.providerSetup.publish(...args)),
    };
    this.catalog = {
      readCatalog: (...args) => this.request((ports) => ports.catalog.readCatalog(...args)),
      execute: (...args) => this.request((ports) => ports.catalog.execute(...args)),
      observeCommands: (binding, listener, onError) =>
        this.observe(
          async (ports, failed) => ports.catalog.observeCommands(binding, listener, failed),
          onError
        ),
      close: () => this.retire(),
      cleanup: () => this.close(),
      retryCleanup: () => this.close(),
    };
  }
  private check(): void {
    if (this.closed || readLocalMachineCatalogOwner(this.options) !== 'native')
      throw new MachineCatalogError('operation_failed');
    assertStorage(this.options);
  }
  private ports(): Promise<Ports> {
    if (this.acquiring) return this.acquiring;
    const work = (async () => {
      this.check();
      const client = await this.host.client();
      this.check();
      if (this.current?.client === client) return this.current.ports;
      if (this.current) {
        this.current.ports.close();
        await this.current.ports.cleanup();
      }
      this.check();
      const generation = (await this.host.leaseInfo(client)).clientGeneration;
      this.check();
      const current = () => {
        try {
          this.check();
          return this.current?.client === client && client.connectionState === 'connected';
        } catch {
          return false;
        }
      };
      const ports = createNativeMachineRuntimePorts({
        losslessWireI64: true,
        client,
        namespace: this.options.workspaceId,
        binding: this.binding,
        writer: `local-mf:${JSON.stringify(this.binding)}`,
        authorize: () => current(),
        authority: {
          current: () => (current() ? { epoch: generation, synced: true } : undefined),
          subscribe: () => () => {},
        },
        upload: async () => this.check(),
      });
      this.current = { client, ports };
      return ports;
    })();
    this.acquiring = work;
    void work
      .finally(() => {
        if (this.acquiring === work) this.acquiring = undefined;
      })
      .catch(() => {});
    return work;
  }
  private async request<A>(work: (ports: Ports) => Promise<A>): Promise<A> {
    const ports = await this.ports();
    this.check();
    // Only acquire before execution; an already-issued mutation is never replayed.
    return work(ports);
  }
  private async observe(
    open: (
      ports: Ports,
      onError: (error: unknown) => void
    ) => Promise<{ close(): void; cleanup?: () => Promise<void> }>,
    onError: (error: unknown) => void
  ) {
    let retired = false,
      lease: Awaited<ReturnType<typeof open>> | undefined;
    let attaching: Promise<void> | undefined;
    let retries = 0;
    const release = async () => {
      if (!lease) return;
      let retirementFailure: unknown;
      try {
        lease.close();
      } catch (error) {
        retirementFailure = error;
      }
      if (!lease.cleanup)
        throw new AggregateError(
          [...(retirementFailure ? [retirementFailure] : [])],
          'Native MF observer release proof is unavailable'
        );
      await lease.cleanup();
      lease = undefined;
    };
    const attach = (): Promise<void> => {
      if (attaching) return attaching;
      const work = (async () => {
        await release();
        if (retired || this.closed) return;
        const ports = await this.ports();
        if (retired || this.closed) return;
        const acquired = await open(ports, failed);
        lease = acquired;
        if (retired || this.closed) await release();
      })();
      attaching = work;
      void work
        .finally(() => {
          if (attaching === work) attaching = undefined;
        })
        .catch(() => {});
      return work;
    };
    const failed = (error: unknown) => {
      if (retired || this.closed) return;
      if (this.current?.client.connectionState !== 'closed' || ++retries > 3) {
        onError(error);
        return;
      }
      // Join the pending native acquisition/cleanup before replacing its exact lease.
      void Promise.resolve(attaching)
        .catch(() => {})
        .then(() => attach())
        .catch(onError);
    };
    const observation = {
      close: () => {
        retired = true;
        lease?.close();
      },
      cleanup: async () => {
        retired = true;
        await attaching?.catch(() => {});
        await release();
        this.observers.delete(observation);
      },
      retryCleanup: async () => observation.cleanup(),
    };
    this.observers.add(observation);
    try {
      await attach();
      return observation;
    } catch (error) {
      try {
        await observation.cleanup();
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'Native MF observation cleanup unconfirmed');
      }
      throw error;
    }
  }
  private retire(): void {
    this.closed = true;
    const failures: unknown[] = [];
    for (const observation of this.observers)
      try {
        observation.close();
      } catch (error) {
        failures.push(error);
      }
    try {
      this.current?.ports.close();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) throw new AggregateError(failures, 'Native MF local retirement failed');
  }
  async ready(): Promise<void> {
    await this.ports();
  }
  close(): Promise<void> {
    // Even a local listener fence failure must not skip independent host release.
    try {
      this.retire();
    } catch {
      /* Exact observers/ports retain retry ownership. */
    }
    if (this.closing) return this.closing;
    const work = (async () => {
      // Closing only this independent lease provides lost-ACK proof without
      // stopping the main process's sibling data lease.
      const first = await Promise.allSettled([
        this.host.close(),
        ...[...this.observers].map((observer) => observer.cleanup()),
        this.current?.ports.cleanup(),
      ]);
      await this.acquiring?.catch(() => {});
      const failures: unknown[] = first[0].status === 'rejected' ? [first[0].reason] : [];
      for (const observer of [...this.observers])
        try {
          await observer.cleanup();
        } catch (error) {
          failures.push(error);
        }
      try {
        await this.current?.ports.cleanup();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length)
        throw new AggregateError(failures, 'Native MF owner release unconfirmed');
    })();
    this.closing = work;
    void work
      .finally(() => {
        if (this.closing === work) this.closing = undefined;
      })
      .catch(() => {});
    return work;
  }
}

export async function openNativeLocalMachineCatalogLegacy(options: {
  accountId: string;
  workspaceId: WorkspaceId;
  machineId: MachineId;
  encrypted: boolean;
  cloud: boolean;
  dataRoot?: string;
  launch?: { executable: string; entry: string };
}): Promise<NativeLocalMachineCatalogLegacy | null> {
  if (!isLocalUserId(options.accountId) || !isLocalWorkspaceId(options.workspaceId)) return null;
  const dataRoot = options.dataRoot ?? rootFor();
  const state = readLocalMachineCatalogOwner({ ...options, dataRoot });
  if (state === 'legacy') return null;
  if (state !== 'native' || options.encrypted || options.cloud)
    throw new MachineCatalogError('operation_failed');
  const proof = await loadNativeRepoSdkCompatibility(import.meta.url);
  if (!proof) throw new Error('Native MF requires a verified compatible SDK artifact');
  const owner = new NativeLocalMachineCatalogLegacy({
    ...options,
    dataRoot,
    requiredSdkArtifactId: proof.artifactId,
  });
  try {
    await owner.ready();
    return owner;
  } catch (error) {
    try {
      await owner.close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Native MF startup cleanup unconfirmed');
    }
    throw error;
  }
}

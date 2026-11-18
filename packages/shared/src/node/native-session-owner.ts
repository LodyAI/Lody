import { createHash } from 'node:crypto';
import { NATIVE_REPO_MIGRATION_FORMAT } from './native-repo-migration-format';
import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { RepoClient } from '@loro-dev/loro-repo-client';
import type { SessionId } from '@lody/shared';
import type { NativeRepoSdkCompatibility } from './native-repo-sdk-compatibility';
import type { IndependentRepoLeaseInfo } from './native-repo-independent-legacy';
import {
  NativeLoroDocumentMigration,
  type NativeLoroDocumentManifest,
  type FrozenLoroDocumentSource,
} from './native-loro-document-migration';
import {
  createNativeSessionDocumentFactory,
  NativeSessionOwnerCleanupError,
} from './native-session-document-owner';
import type { NativeSessionDocumentFactory } from './native-session-document';

import {
  readLocalNativeSessionRoute,
  readLocalNativeSessionMigration,
  resolveLocalNativeSessionPaths,
  type LocalNativeSessionBinding,
} from './native-session-routing';
export {
  readLocalNativeSessionRoute,
  readLocalNativeSessionMigration,
  type LocalNativeSessionBinding,
} from './native-session-routing';
export type NativeLocalSessionHost = {
  client(): Promise<RepoClient>;
  leaseInfo(client: RepoClient): Promise<IndependentRepoLeaseInfo>;
  /** This owner receives an exclusive lease facade, never a shared host facade
   * whose close would retire another catalog owner. The engine itself is shared. */
  close(): Promise<void>;
};
/** Durable local body routing over the same independent engine used by main and
 * daemon. Migration requires explicit complete source inventories and frozen
 * writer drains; ordinary opens cannot opt a room into native ownership. */
/** @deprecated Promise composition facade; room ownership itself uses its Effect Scope. */
export class NativeLocalSessionOwnerLegacy {
  readonly factory: NativeSessionDocumentFactory;
  readonly targetGeneration: string;
  private readonly selected;
  private current: RepoClient | undefined;
  private closed = false;
  private closing: Promise<void> | undefined;
  private migration: NativeLoroDocumentMigration | undefined;
  private migrationClient: RepoClient | undefined;
  private controllerPending: Promise<NativeLoroDocumentMigration> | undefined;
  private readonly migrationJobs = new Set<Promise<unknown>>();
  constructor(
    private readonly options: LocalNativeSessionBinding & {
      readonly compatibility: NativeRepoSdkCompatibility;
      readonly host: NativeLocalSessionHost;
      readonly writer: string;
      readonly closeTimeoutMs: number;
      readonly editingLeaseMs: number;
      readonly now: () => number;
      onBackgroundFailure(error: unknown): void;
    }
  ) {
    if (!Number.isFinite(options.closeTimeoutMs) || options.closeTimeoutMs <= 0)
      throw new Error('Native Session close budget is required');
    this.selected = resolveLocalNativeSessionPaths(options);
    this.targetGeneration = createHash('sha256')
      .update(
        JSON.stringify([
          this.selected.binding,
          options.compatibility.artifactId,
          NATIVE_REPO_MIGRATION_FORMAT,
        ])
      )
      .digest('hex');
    const core = createNativeSessionDocumentFactory({
      binding: { accountId: options.accountId, workspaceId: options.workspaceId },
      ownsRoom: (roomId) => readLocalNativeSessionRoute(options, roomId) !== 'legacy',
      acquire: async (id) => {
        const route = readLocalNativeSessionRoute(options, `session-${id}`);
        if (route === 'legacy') return undefined;
        this.requireCurrent(id);
        const client = await options.host.client();
        const lease = await options.host.leaseInfo(client);
        this.requireCurrent(id);
        if (lease.sdkArtifactId !== options.compatibility.artifactId)
          throw new Error('Native Session host artifact mismatch');
        this.assertStorage(id);
        this.current = client;
        return {
          dataDir: this.selected.dataDir,
          namespace: options.workspaceId,
          sessionId: id,
          client,
          writer: options.writer,
          contentMode: 'plaintext',
          compatibility: options.compatibility,
          requiredSdkArtifactId: lease.sdkArtifactId,
          closeTimeoutMs: options.closeTimeoutMs,
          editingLeaseMs: options.editingLeaseMs,
          now: options.now,
          assertCurrent: () => {
            this.requireCurrent(id);
            if (this.current !== client || client.connectionState !== 'connected')
              throw new Error('Native Session client generation changed');
          },
          // This local-only scope has no remote transport. Engine durability and
          // inbound document coverage are not a cloud-sync acknowledgement.
          waitUntilSynced: async () => false,
          onBackgroundFailure: options.onBackgroundFailure,
        };
      },
    });
    this.factory = Object.assign(
      (...args: Parameters<NativeSessionDocumentFactory>) => core(...args),
      {
        binding: core.binding,
        ownsRoom: core.ownsRoom,
        retireRoom: (id: SessionId) => this.retireCoreRoom(id),
        assertLegacyRoom: (roomId: string) => {
          if (this.closed || readLocalNativeSessionRoute(this.options, roomId) !== 'legacy')
            throw new Error('Legacy Session body is frozen');
        },
        close: () => this.close(),
      }
    );
    this.closeCore = () => core.close();
    this.retireCoreRoom = (id) => {
      if (!core.retireRoom) throw new Error('Target Session retirement is unavailable');
      return core.retireRoom(id);
    };
  }
  private readonly closeCore: () => Promise<void>;
  private readonly retireCoreRoom: (sessionId: SessionId) => Promise<void>;
  private requireCurrent(id: SessionId): void {
    if (this.closed || readLocalNativeSessionRoute(this.options, `session-${id}`) !== 'native')
      throw new Error('Native Session migration/restart required');
    this.assertStorage(id);
  }
  private assertStorage(id: SessionId): void {
    const db = new DatabaseSync(
      join(
        this.selected.dataDir,
        'namespaces',
        `ns_${Buffer.from(this.options.workspaceId).toString('hex')}.sqlite3`
      ),
      { readOnly: true, timeout: 0 }
    );
    try {
      const schema = db.prepare("SELECT v FROM v2_meta WHERE k='schema_version'").get() as
        | { v: number }
        | undefined;
      const row = db
        .prepare('SELECT encryption FROM v2_rooms WHERE room_kind=1 AND room_id=?')
        .get(`session-${id}`) as { encryption: number } | undefined;
      if (schema?.v !== 1 || row?.encryption !== 0)
        throw new Error('Published native Session storage requires recovery');
    } finally {
      db.close();
    }
  }
  private controller(): Promise<NativeLoroDocumentMigration> {
    if (this.closed) return Promise.reject(new Error('Native Session owner is closed'));
    if (this.migration && this.migrationClient?.connectionState === 'connected')
      return Promise.resolve(this.migration);
    if (this.controllerPending) return this.controllerPending;
    const pending = (async () => {
      if (this.migration) {
        if (this.migrationJobs.size > 1)
          throw new Error('Previous Session migration generation is still draining');
        this.migration.close();
        this.migration = undefined;
        this.migrationClient = undefined;
      }
      const client = await this.options.host.client();
      const lease = await this.options.host.leaseInfo(client);
      if (this.closed || lease.sdkArtifactId !== this.options.compatibility.artifactId)
        throw new Error('Native Session migration host artifact mismatch');
      await mkdir(dirname(this.selected.journalPath), { recursive: true });
      if (this.closed) throw new Error('Native Session owner closed during journal acquisition');
      this.migration = new NativeLoroDocumentMigration(this.selected.journalPath, {
        client,
        assertAccess: (manifest) => {
          if (
            this.closed ||
            client.connectionState !== 'connected' ||
            manifest.family !== 'session' ||
            manifest.binding !== this.selected.migrationBinding ||
            manifest.namespace !== this.options.workspaceId ||
            manifest.targetGeneration !== this.targetGeneration
          )
            throw new Error('Native Session migration authority changed');
        },
      });
      this.migrationClient = client;
      return this.migration;
    })().finally(() => {
      if (this.controllerPending === pending) this.controllerPending = undefined;
    });
    this.controllerPending = pending;
    return pending;
  }
  private runMigration<A>(work: () => Promise<A>): Promise<A> {
    if (this.closed) return Promise.reject(new Error('Native Session owner is closed'));
    const raw = Promise.resolve().then(work);
    this.migrationJobs.add(raw);
    void raw.finally(() => this.migrationJobs.delete(raw)).catch(() => undefined);
    return raw;
  }
  private async drainMigrations(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...this.migrationJobs]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new NativeSessionOwnerCleanupError([], () => this.drainMigrations())),
            this.options.closeTimeoutMs
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async readArchivedSources(
    sessionId: SessionId
  ): Promise<readonly FrozenLoroDocumentSource[] | undefined> {
    return this.runMigration(async () => {
      const row = readLocalNativeSessionMigration(this.options, `session-${sessionId}`);
      if (!row) return undefined;
      return (await this.controller()).archivedSources(row.manifest);
    });
  }
  async migrate(
    input: {
      readonly sessionId: SessionId;
      readonly migrationId: string;
      readonly sourceIds: readonly string[];
      readonly historyBackend: 'loro';
    },
    ports: Parameters<NativeLoroDocumentMigration['migrate']>[1]
  ): Promise<void> {
    return this.runMigration(async () => {
      if (input.historyBackend !== 'loro')
        throw new Error('Roost is excluded from native Session migration');
      const controller = await this.controller();
      await controller.migrate(
        {
          migrationId: input.migrationId,
          binding: this.selected.migrationBinding,
          namespace: this.options.workspaceId,
          roomId: `session-${input.sessionId}`,
          family: 'session',
          targetGeneration: this.targetGeneration,
          sourceIds: [...input.sourceIds],
        },
        ports
      );
    });
  }
  /** One UUID, one trusted Meta reservation and only this Session's writer
   * drains. Empty history is authored by typed SDK patches, never raw import. */
  async createNew(
    input: {
      readonly sessionId: SessionId;
      readonly reservationId: string;
      readonly creationIntentSha256: string;
    },
    ports: Parameters<NativeLoroDocumentMigration['createSession']>[1]
  ): Promise<void> {
    return this.runMigration(async () => {
      const controller = await this.controller();
      const client = await this.options.host.client();
      const lease = await this.options.host.leaseInfo(client);
      if (lease.sdkArtifactId !== this.options.compatibility.artifactId)
        throw new Error('Native Session creation artifact mismatch');
      await controller.createSession(
        {
          migrationId: input.reservationId,
          creationIntentSha256: input.creationIntentSha256,
          binding: this.selected.migrationBinding,
          namespace: this.options.workspaceId,
          roomId: `session-${input.sessionId}`,
          targetGeneration: this.targetGeneration,
        },
        ports
      );
    });
  }
  async rollback(
    manifest: NativeLoroDocumentManifest,
    ports: {
      drainNative(): Promise<void>;
      mergeAndFlushLegacy(native: Uint8Array): Promise<readonly FrozenLoroDocumentSource[]>;
    }
  ): Promise<void> {
    return this.runMigration(async () => {
      const controller = await this.controller();
      await controller.rollback(manifest, {
        ...ports,
        drainNative: async () => {
          await this.retireCoreRoom(manifest.roomId.slice('session-'.length) as SessionId);
          await ports.drainNative();
        },
      });
    });
  }
  close(): Promise<void> {
    this.closed = true;
    if (this.closing) return this.closing;
    this.closing = (async () => {
      let coreFailure: unknown;
      let hostFailure: unknown;
      try {
        await this.closeCore();
      } catch (error) {
        coreFailure = error;
      }
      try {
        await this.options.host.close();
      } catch (error) {
        hostFailure = error;
      }
      // Only retry the retained core owner after actual host cleanup. SDK handles
      // cannot independently turn a lost ACK into confirmed release.
      if (coreFailure) {
        try {
          await this.closeCore();
          coreFailure = undefined;
        } catch (error) {
          coreFailure = error;
        }
      }
      let migrationFailure: unknown;
      try {
        await this.drainMigrations();
      } catch (error) {
        migrationFailure = error;
      }
      const failures = [coreFailure, hostFailure, migrationFailure].filter(
        (error) => error !== undefined
      );
      if (failures.length) throw new NativeSessionOwnerCleanupError(failures, () => this.close());
      this.migration?.close();
    })().finally(() => {
      this.closing = undefined;
    });
    return this.closing;
  }
}

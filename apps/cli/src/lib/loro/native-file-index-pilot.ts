import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LoroRepo } from 'loro-repo';
import type { RepoClient, SubscriptionHandle } from '@loro-dev/loro-repo-client';
import {
  getCodeCollabFileIndexFlockDocId,
  getCodeCollabFileIndexSignalFlockDocId,
  readCodeCollabFileIndexSnapshotFromFlock,
  getServerNow,
  type SessionId,
  type WorkspaceId,
} from '@lody/shared';
import { isLocalUserId, isLocalWorkspaceId } from '@lody/shared/platform-kind';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import type { LocalNativeFileIndexSource } from '@lody/shared/local-loro-data-plane-server';
import {
  createLegacyCodeCollabPublicationStore,
  type CodeCollabPublicationStore,
} from '../code-collab/code-collab-publication-store';
import { createNativeLocalCodeCollabPublicationStore } from '../code-collab/code-collab-native-publication-store';
import { NativeRepoHostLegacy, type NativeRepoHostOptions } from './native-repo-host';
import { IndependentNativeRepoHostLegacy } from '@lody/shared/node/native-repo-independent-legacy';
import { resolveLocalIndependentRepo } from '@lody/shared/node/native-repo-independent-paths';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCliNodeExecutable } from '../managed-daemon-release';
import { toShared } from '@/platform/process-options';
import {
  NativeRepoMigrationJournal,
  readNativeFlockSnapshot,
  verifyFrozenFlockMigration,
  verifyLegacyFlockRollback,
  type FrozenFlockSource,
} from './native-repo-migration';

const generation = 'engine-0.1.0-v1';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type Options = {
  readonly workspaceId: WorkspaceId;
  readonly userId: string;
  readonly repo: LoroRepo;
  readonly mode: 'native' | 'rollback' | 'existing';
  readonly directory: string;
  readonly host?: Pick<NativeRepoHostOptions, 'entry' | 'executable'>;
  readonly independentHost?: {
    readonly binding: string;
    readonly executable: string;
    readonly entry: string;
  };
  readonly closeBudgetMs?: number;
};

/** Daemon-only local FI/FIS ownership. No remote, catalog, history or Roost access. */
export class NativeFileIndexPilotLegacy {
  private readonly journal;
  private readonly host;
  private readonly binding;
  private readonly dataDir;
  private readonly legacy;
  private readonly preparing = new Map<string, Promise<CodeCollabPublicationStore>>();
  private readonly published = new Set<string>();
  private readonly refreshers = new Map<string, Set<() => void>>();
  private closed = false;
  private closing: Promise<void> | null = null;
  readonly source: LocalNativeFileIndexSource;

  constructor(private readonly options: Options) {
    this.binding = JSON.stringify([options.userId, options.workspaceId]);
    this.dataDir = join(options.directory, options.independentHost ? 'engine' : generation);
    this.journal = new NativeRepoMigrationJournal(join(options.directory, 'routes.sqlite3'));
    this.host = options.independentHost
      ? new IndependentNativeRepoHostLegacy(
          { dataDir: this.dataDir, ...options.independentHost },
          toShared()
        )
      : new NativeRepoHostLegacy({ dataDir: this.dataDir, ...options.host });
    this.legacy = createLegacyCodeCollabPublicationStore(options.repo);
    this.source = { subscribe: (owner, listener) => this.subscribe(owner, listener) };
  }

  private rooms(owner: string) {
    if (!owner || owner.includes('\0')) throw new Error('Invalid file-index owner');
    return [
      {
        kind: 'flock' as const,
        id: getCodeCollabFileIndexFlockDocId(this.options.workspaceId, owner as SessionId),
      },
      {
        kind: 'flock' as const,
        id: getCodeCollabFileIndexSignalFlockDocId(this.options.workspaceId, owner as SessionId),
      },
    ];
  }

  async store(owner: string): Promise<CodeCollabPublicationStore> {
    if (this.closed) throw new Error('Native file-index pilot is closed');
    const pending = this.preparing.get(owner);
    if (pending) return pending;
    const operation = this.prepare(owner).finally(() => this.preparing.delete(owner));
    this.preparing.set(owner, operation);
    return operation;
  }

  private async legacySnapshot(roomId: string, merge?: Uint8Array) {
    const lease = await this.options.repo.acquireFlockDoc(roomId);
    try {
      this.checkOpen();
      if (merge) {
        lease.flock.strictImportFile(merge);
        lease.flock.commit();
        await this.options.repo.persistFlockDocNow(roomId, lease.flock);
        await this.options.repo.flush();
      }
      return lease.flock.exportFile();
    } finally {
      await lease.release();
      // A remaining legacy holder means ownership was not drained. Refuse the
      // migration instead of deleting a live wrapper or starting dual writers.
      await this.options.repo.unloadFlockDoc(roomId);
    }
  }

  private checkOpen(): void {
    if (this.closed) throw new Error('Native file-index pilot is closed');
  }

  private async prepare(owner: string): Promise<CodeCollabPublicationStore> {
    const rooms = this.rooms(owner);
    const route = this.journal.routeGroup(this.binding, rooms);
    if (route.owner === 'legacy' && this.options.mode !== 'native') return this.legacy;
    const client = await this.host.client();
    this.checkOpen();
    if (route.owner !== 'legacy' && route.targetGeneration !== generation)
      throw new Error('Unsupported file-index owner generation');
    if (route.owner === 'native' && this.options.mode === 'rollback') {
      const proofs = [];
      for (const room of rooms) {
        await client.compactRoom(this.options.workspaceId, room);
        this.checkOpen();
        const nativeSnapshot = readNativeFlockSnapshot({
          dataDir: this.dataDir,
          namespace: this.options.workspaceId,
          room,
        });
        const legacyBefore = await this.legacySnapshot(room.id);
        this.checkOpen();
        const legacyAfter = await this.legacySnapshot(room.id, nativeSnapshot.bytes);
        this.checkOpen();
        proofs.push(
          verifyLegacyFlockRollback({
            intent: this.journal.getIntent(this.binding, room)!,
            nativeSnapshot,
            legacyBefore,
            legacyAfter,
          })
        );
      }
      this.journal.completeRollbackGroup(this.binding, rooms, route.migrationId, proofs);
      return this.legacy;
    }
    if (route.owner !== 'native') {
      const migrationId = route.owner === 'frozen' ? route.migrationId : randomUUID();
      if (!/^[a-f0-9-]+$/.test(migrationId)) throw new Error('Invalid migration archive identity');
      const archive = join(this.options.directory, 'sources', migrationId);
      await mkdir(archive, { recursive: true, mode: 0o700 });
      this.checkOpen();
      const sources: FrozenFlockSource[] = [];
      for (let index = 0; index < rooms.length; index++) {
        const source = join(archive, `${index}.flock`);
        if (route.owner === 'legacy') {
          const snapshot = await this.legacySnapshot(rooms[index]!.id);
          this.checkOpen();
          await writeFile(source, snapshot, { mode: 0o600, flag: 'wx' });
        }
        sources.push({ sourceId: 'legacy-cli', snapshot: await readFile(source) });
        this.checkOpen();
      }
      if (route.owner === 'legacy') {
        this.journal.freezeGroup(
          rooms.map((room, index) => ({
            migrationId,
            binding: this.binding,
            namespace: this.options.workspaceId,
            room,
            targetGeneration: generation,
            sources: [{ sourceId: 'legacy-cli', sha256: sha(sources[index]!.snapshot) }],
          }))
        );
      }
      for (let index = 0; index < rooms.length; index++) {
        const room = rooms[index]!;
        await client.createRoom(this.options.workspaceId, room, 'plaintext');
        this.checkOpen();
        await client.importRoomState(this.options.workspaceId, room, {
          snapshot: sources[index]!.snapshot,
          enqueueOutbox: false,
        });
        this.checkOpen();
        await client.compactRoom(this.options.workspaceId, room);
        this.checkOpen();
        const proof = verifyFrozenFlockMigration(
          readNativeFlockSnapshot({
            dataDir: this.dataDir,
            namespace: this.options.workspaceId,
            room,
          }),
          [sources[index]!]
        );
        this.journal.verify(this.binding, migrationId, proof);
      }
      this.journal.publishGroup(this.binding, rooms, migrationId);
    }
    return createNativeLocalCodeCollabPublicationStore({
      client,
      namespace: this.options.workspaceId,
      workspaceId: this.options.workspaceId,
    });
  }

  /** Call after the authoritative filesystem refresh publication settles. */
  markPublished(owner: string): void {
    if (this.closed) return;
    this.published.delete(owner);
    this.published.add(owner);
    if (this.published.size > 64) this.published.delete(this.published.values().next().value!);
    for (const refresh of this.refreshers.get(owner) ?? []) refresh();
  }

  async ownsRoom(roomId: string): Promise<boolean> {
    const prefix = [`${this.options.workspaceId}:fi:`, `${this.options.workspaceId}:fis:`].find(
      (p) => roomId.startsWith(p)
    );
    if (!prefix) return false;
    const owner = roomId.slice(prefix.length);
    await this.store(owner);
    return this.journal.routeGroup(this.binding, this.rooms(owner)).owner === 'native';
  }

  private async subscribe(
    owner: string,
    listener: Parameters<LocalNativeFileIndexSource['subscribe']>[1]
  ) {
    await this.store(owner);
    if (this.journal.routeGroup(this.binding, this.rooms(owner)).owner !== 'native') return null;
    const [indexRoom, signalRoom] = this.rooms(owner);
    let closed = false;
    let dirty = false;
    let running: Promise<void> | null = null;
    let client: RepoClient | undefined;
    let bound = false;
    let unlisten = () => {};
    let subscriptions: SubscriptionHandle[] = [];
    let uncertainRelease:
      | { client: RepoClient; cause: unknown; lost: boolean; unlisten(): void }
      | undefined;
    const releaseSubscriptions = async () => {
      if (uncertainRelease) {
        if (!uncertainRelease.lost && uncertainRelease.client.connectionState === 'connected')
          throw uncertainRelease.cause;
        uncertainRelease.unlisten();
        uncertainRelease = undefined;
      }
      const previous = subscriptions;
      const results = await Promise.allSettled(previous.map((sub) => sub.unsubscribe()));
      // SDK 0.1.0 forgets the handle before sending unsubscribe. Calling it
      // again after a rejected ACK is a local no-op, not release evidence.
      subscriptions = [];
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      );
      if (failures.length && client?.connectionState === 'connected') {
        const cause = new AggregateError(
          failures,
          'Native index observation release is unconfirmed'
        );
        const retained = { client, cause, lost: false, unlisten: () => {} };
        uncertainRelease = retained;
        retained.unlisten = client.onConnectionStateChange((state) => {
          if (state !== 'connected') retained.lost = true;
        });
        if (client.connectionState !== 'connected') retained.lost = true;
        throw cause;
      }
    };
    const bind = async (next: RepoClient) => {
      if (next === client && bound) return;
      unlisten();
      await releaseSubscriptions();
      if (closed) return;
      client = next;
      bound = false;
      unlisten = next.onConnectionStateChange((state) => {
        if (closed) return;
        listener({ status: 'loading' });
        // Reacquire only this observer's SDK generation. Never replay a write,
        // stop the shared host, or leave a mounted View permanently on an old client.
        if (state === 'closed' || state === 'connected') refresh();
      });
      for (const room of [indexRoom!, signalRoom!]) {
        const subscription = await next.flockSubscribe(this.options.workspaceId, room, {}, refresh);
        // Ownership is registered before the late-close branch. Unsubscribe
        // forgets the SDK handle before its ACK, so a failed late release must
        // retain the same uncertain owner as an already mounted observation.
        subscriptions.push(subscription);
        if (closed) {
          await releaseSubscriptions();
          return;
        }
      }
      bound = true;
    };
    const refresh = () => {
      dirty = true;
      if (closed || running || !this.published.has(owner)) return;
      running = (async () => {
        while (dirty && !closed) {
          dirty = false;
          const next = await this.host.client();
          if (closed) return;
          await bind(next);
          if (closed) return;
          const snapshot = await next.flockScan(this.options.workspaceId, indexRoom!);
          if (closed) return;
          const { fileIndex, generations } = readCodeCollabFileIndexSnapshotFromFlock({
            scan: () => snapshot.entries,
          });
          listener({ status: 'ready', fileIndex, generations, updatedAtMs: getServerNow() });
        }
      })()
        .catch(() => {
          if (!closed) listener({ status: 'error', code: 'native_index_unavailable' });
        })
        .finally(() => {
          running = null;
          if (dirty && !closed) refresh();
        });
    };
    const refreshers = this.refreshers.get(owner) ?? new Set<() => void>();
    this.refreshers.set(owner, refreshers);
    refreshers.add(refresh);
    listener({ status: 'loading' });
    // No read before the authoritative filesystem publication has settled.
    refresh();
    return {
      release: async () => {
        closed = true;
        unlisten();
        refreshers.delete(refresh);
        if (!refreshers.size) this.refreshers.delete(owner);
        await releaseSubscriptions();
        await running;
        await releaseSubscriptions();
      },
    };
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      // Ending our host/client interrupts native RPCs. Waiting on those RPCs
      // before this step would deadlock shutdown when the native host stalls.
      const failures: unknown[] = [];
      try {
        await this.host.close();
      } catch (error) {
        failures.push(error);
      }
      const drain = Promise.allSettled([...this.preparing.values()]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const observed = drain.then(() => {
        settled = true;
        this.journal.close();
      });
      try {
        await Promise.race([
          observed,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('Native file-index migration drain is unconfirmed')),
              this.options.closeBudgetMs ?? 5000
            );
          }),
        ]);
      } catch (error) {
        failures.push(error);
      } finally {
        if (timer) clearTimeout(timer);
      }
      // A late legacy I/O completion retains this journal owner until it
      // settles; every continuation checks closed before changing routes.
      if (!settled) void observed.catch(() => undefined);
      if (failures.length) throw new AggregateError(failures, 'Native file-index shutdown failed');
    })().catch((error) => {
      this.closing = null;
      throw error;
    });
    return this.closing;
  }
}

export async function openNativeFileIndexPilotLegacy(args: {
  workspaceId: WorkspaceId;
  userId: string;
  repo: LoroRepo;
  daemon: boolean;
  encrypted: boolean;
}): Promise<NativeFileIndexPilotLegacy | null> {
  if (
    !args.daemon ||
    args.encrypted ||
    !isLocalWorkspaceId(args.workspaceId) ||
    !isLocalUserId(args.userId)
  )
    return null;
  const binding = createHash('sha256')
    .update(JSON.stringify([args.userId, args.workspaceId]))
    .digest('hex');
  let directory = join(getLodyDataDir('local'), 'native-repo', 'v1', binding);
  const independent = resolveLocalIndependentRepo({
    platform: 'local',
    accountId: args.userId,
    workspaceId: args.workspaceId,
    dataRoot: getLodyDataDir('local'),
  });
  const independentSelected =
    process.env.LODY_NATIVE_REPO_MODE === 'independent' ||
    process.env.LODY_NATIVE_WORKSPACE_CATALOG === '1' ||
    existsSync(join(independent.directory, 'routes.sqlite3')) ||
    existsSync(join(independent.dataDir, 'independent-mode.json'));
  if (independentSelected && existsSync(join(independent.classicDirectory, 'routes.sqlite3')))
    throw new Error(
      'Classic native rooms require an explicit ownership migration before independent mode'
    );
  if (independentSelected) directory = independent.directory;
  const mode =
    process.env.LODY_NATIVE_FILE_INDEX === '1'
      ? 'native'
      : process.env.LODY_NATIVE_FILE_INDEX === 'rollback'
        ? 'rollback'
        : 'existing';
  if (mode === 'existing' && !existsSync(join(directory, 'routes.sqlite3'))) return null;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return new NativeFileIndexPilotLegacy({
    ...args,
    directory,
    mode,
    independentHost: independentSelected
      ? {
          binding: independent.binding,
          executable: getCliNodeExecutable(),
          entry: join(dirname(fileURLToPath(import.meta.url)), 'native-repo-independent-host.js'),
        }
      : undefined,
  });
}

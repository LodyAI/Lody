import {
  createLoroStreamUrl,
  getRoostHistoryStreamId,
  LORO_STREAMS_BUCKET_ID,
  parseRoostHistoryRemoteBinding,
  type RoostStreamsConnection,
  type SessionId,
  type SessionRoostHistoryRemoteDocState,
  type WorkspaceId,
} from '@lody/shared';
import type {
  ClientOptions,
  RemoteRecord,
  RoostNodeClient,
  RoostNodeSync,
} from '@loro-dev/roost/node/client.mjs';
import type { Logger } from '@/utils/logger';

export type RoostSyncOwner = {
  readonly client: Pick<
    RoostNodeClient,
    'stream' | 'registerRemote' | 'listRemotes' | 'setRemoteEnabled'
  >;
  readonly owner: Uint8Array;
  bindAuth(remoteId: Uint8Array, auth: NonNullable<ClientOptions['auth']>): () => void;
  release(): Promise<void>;
};

export type RoostSessionSync = {
  markDirty(): void;
  waitUntilSynced(options?: { timeoutMs?: number }): Promise<boolean>;
};

export type RoostWorkspaceSyncOptions = {
  readonly workspaceId: WorkspaceId;
  readonly isCloudEnabled: () => boolean;
  readonly getConnection: () => RoostStreamsConnection | undefined;
  readonly logger: Logger;
};

type Waiter = {
  version: number;
  resolve(value: boolean): void;
  timer: ReturnType<typeof setTimeout>;
};
type Task = {
  sessionId: SessionId;
  binding: SessionRoostHistoryRemoteDocState;
  version: number;
  confirmedVersion: number;
  due: number;
  failures: number;
  connection?: RoostStreamsConnection;
  sync?: RoostNodeSync;
  unbindAuth?: () => void;
  waiters: Set<Waiter>;
};

const TABLE = 'lody_remote_sessions_v1';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

/** Schedules the native durable uploader. This index only discovers local
 * streams after restart; native Roost owns receipts, retries and confirmation.
 * Recovery never opens session control documents or joins their rooms. */
export class RoostWorkspaceHistorySync {
  private readonly tasks = new Map<SessionId, Task>();
  private readonly pending = new Set<Task>();
  private readonly catalog;
  private remotes: RemoteRecord[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private disposed = false;
  private bindSerial: Promise<void> = Promise.resolve();

  private constructor(
    private readonly owner: RoostSyncOwner,
    private readonly options: RoostWorkspaceSyncOptions
  ) {
    this.catalog = owner.client.stream(`lody-history-sync:${options.workspaceId}`);
  }

  static async open(owner: RoostSyncOwner, options: RoostWorkspaceSyncOptions) {
    const sync = new RoostWorkspaceHistorySync(owner, options);
    try {
      sync.remotes = await owner.client.listRemotes();
      let start = new Uint8Array();
      for (;;) {
        const page = await sync.catalog.scanIndex(TABLE, start, 128n);
        for (const row of page) {
          const binding = parseRoostHistoryRemoteBinding(JSON.parse(decoder.decode(row.value)));
          if (!binding || binding.ownerPublicKey !== hex(owner.owner)) {
            throw new Error('Roost synchronization catalog owner mismatch');
          }
          sync.addTask(decoder.decode(row.key) as SessionId, binding);
        }
        if (page.length < 128) break;
        start = new Uint8Array(page.at(-1)!.key.length + 1);
        start.set(page.at(-1)!.key);
      }
      sync.wake();
      return sync;
    } catch (error) {
      await sync.dispose();
      throw error;
    }
  }

  private addTask(sessionId: SessionId, binding: SessionRoostHistoryRemoteDocState): Task {
    const existing = this.tasks.get(sessionId);
    if (existing) {
      if (
        existing.binding.generation !== binding.generation ||
        existing.binding.ownerPublicKey !== binding.ownerPublicKey
      ) {
        throw new Error('Roost history synchronization binding changed');
      }
      return existing;
    }
    const task: Task = {
      sessionId,
      binding,
      version: 1,
      confirmedVersion: 0,
      due: 0,
      failures: 0,
      waiters: new Set(),
    };
    this.tasks.set(sessionId, task);
    this.pending.add(task);
    return task;
  }

  async bind(
    sessionId: SessionId,
    binding: SessionRoostHistoryRemoteDocState
  ): Promise<RoostSessionSync> {
    if (this.disposed) throw new Error('Roost history synchronization is disposed');
    if (binding.ownerPublicKey !== hex(this.owner.owner))
      throw new Error('Roost history owner mismatch');
    const persist = this.bindSerial.then(async () => {
      const key = encoder.encode(sessionId);
      const [prior] = await this.catalog.readIndex([{ table: TABLE, key }]);
      if (prior) {
        const stored = parseRoostHistoryRemoteBinding(JSON.parse(decoder.decode(prior)));
        if (
          stored?.generation !== binding.generation ||
          stored.ownerPublicKey !== binding.ownerPublicKey
        ) {
          throw new Error('Roost history synchronization catalog binding changed');
        }
      } else if (
        !(await this.catalog.compareAndWriteIndex(
          [{ table: TABLE, key, value: null }],
          [{ table: TABLE, key, value: encoder.encode(JSON.stringify(binding)) }]
        ))
      ) {
        throw new Error('Roost history synchronization catalog changed concurrently');
      }
    });
    this.bindSerial = persist.catch(() => {});
    // Register before accepting the first write. A crash after any native
    // commit remains discoverable even if the wakeup below was never delivered.
    await persist;
    if (this.disposed) throw new Error('Roost history synchronization is disposed');
    const task = this.addTask(sessionId, binding);
    this.schedule();
    return {
      markDirty: () => {
        if (this.disposed) return;
        task.version += 1;
        this.pending.add(task);
        task.due = 0;
        this.schedule();
      },
      waitUntilSynced: async (options) => {
        if (this.disposed) return false;
        if (!this.options.isCloudEnabled()) return true;
        const version = task.version;
        if (task.confirmedVersion >= version) return true;
        this.pending.add(task);
        task.due = 0;
        this.schedule();
        return await new Promise<boolean>((resolve) => {
          const waiter: Waiter = {
            version,
            resolve,
            timer: setTimeout(() => {
              task.waiters.delete(waiter);
              resolve(false);
            }, options?.timeoutMs ?? 20_000),
          };
          task.waiters.add(waiter);
        });
      },
    };
  }

  /** Connection health is a wakeup for pending work, not a workspace scan. */
  wake(): void {
    for (const task of this.pending) task.due = 0;
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const connection = this.options.getConnection();
    if (
      this.disposed ||
      this.running ||
      !connection ||
      connection.signal.aborted ||
      !this.pending.size
    )
      return;
    let next = Infinity;
    for (const task of this.pending) next = Math.min(next, task.due);
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.running = this.step().finally(() => {
          this.running = undefined;
          this.schedule();
        });
      },
      Math.max(0, next - Date.now())
    );
    this.timer.unref?.();
  }

  private async prepare(task: Task, connection: RoostStreamsConnection): Promise<RoostNodeSync> {
    if (task.connection === connection && task.sync) return task.sync;
    task.unbindAuth?.();
    task.sync = undefined;
    const physicalStream = getRoostHistoryStreamId(
      this.options.workspaceId,
      task.sessionId,
      task.binding.generation
    );
    const url = createLoroStreamUrl({
      baseUrl: connection.baseUrl,
      bucketId: LORO_STREAMS_BUCKET_ID,
      streamId: physicalStream,
    });
    const name = JSON.stringify([
      'lody-roost-v1',
      this.options.workspaceId,
      task.sessionId,
      task.binding.generation,
    ]);
    const generation = { bytes: encoder.encode(task.binding.generation), source: 'app_marker' };
    let remote = this.remotes.find(
      (item) =>
        item.name === name &&
        item.url === url &&
        item.physicalStream === physicalStream &&
        decoder.decode(item.generation.bytes) === task.binding.generation &&
        item.generation.source === generation.source
    );
    if (!remote) {
      const { id } = await this.owner.client.registerRemote({
        name,
        url,
        physicalStream,
        generation,
      });
      remote = { id, name, url, physicalStream, generation, enabled: true };
      this.remotes.push(remote);
    } else if (!remote.enabled) {
      await this.owner.client.setRemoteEnabled(remote.id, true);
      remote.enabled = true;
    }
    let lastToken: string | undefined;
    task.unbindAuth = this.owner.bindAuth(remote.id, async ({ reason, signal }) => {
      if (
        this.disposed ||
        connection.signal.aborted ||
        signal.aborted ||
        this.options.getConnection() !== connection
      ) {
        throw new Error('Roost Streams access was revoked');
      }
      const token = await connection.auth({ reason, previousToken: lastToken });
      if (
        !token ||
        connection.signal.aborted ||
        signal.aborted ||
        this.options.getConnection() !== connection
      ) {
        throw new Error('Roost Streams authorization is unavailable');
      }
      lastToken = token;
      return token;
    });
    const sync = this.owner.client.stream(`lody-session:${task.sessionId}`).sync(remote.id, {
      partial: false,
      encryption: 'plaintext',
      authentication: 'host',
    });
    await sync.ensureRemote({ signal: connection.signal });
    if (this.disposed || connection.signal.aborted || this.options.getConnection() !== connection) {
      throw new Error('Roost Streams connection changed');
    }
    task.connection = connection;
    task.sync = sync;
    return sync;
  }

  private async step(): Promise<void> {
    const connection = this.options.getConnection();
    if (!connection || connection.signal.aborted || this.disposed) return;
    const task = [...this.pending].find((entry) => entry.due <= Date.now());
    if (!task) return;
    const version = task.version;
    try {
      const sync = await this.prepare(task, connection);
      // One native package per scheduling slice keeps long backlogs from
      // monopolizing the shared owner. Native discovery/receipts survive exit.
      const report = await sync.upload({ maxSend: 1n }, { signal: connection.signal });
      if (this.disposed || connection.signal.aborted || this.options.getConnection() !== connection)
        return;
      if (report.transportError || report.waitingLocal.length || report.waitingParents.length) {
        throw new Error('Roost history upload has unconfirmed work');
      }
      task.failures = 0;
      const drained =
        report.sent.length === 0 && report.confirmed.length === 0 && report.tasksCreated === 0n;
      if (drained) {
        task.confirmedVersion = Math.max(task.confirmedVersion, version);
        for (const waiter of task.waiters) {
          if (waiter.version > task.confirmedVersion) continue;
          task.waiters.delete(waiter);
          clearTimeout(waiter.timer);
          waiter.resolve(true);
        }
        if (task.version === version) this.pending.delete(task);
      }
      // Round-robin slices among streams, including ones resumed on startup.
      if (this.pending.delete(task)) this.pending.add(task);
      task.due = 0;
    } catch {
      if (!this.disposed && !connection.signal.aborted) {
        if (task.failures === 0)
          this.options.logger.warn(`Roost history upload will retry (session=${task.sessionId})`);
        task.failures += 1;
        task.due = Date.now() + Math.min(30_000, 500 * 2 ** Math.min(task.failures, 6));
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    for (const task of this.tasks.values()) {
      task.unbindAuth?.();
      for (const waiter of task.waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(false);
      }
      task.waiters.clear();
    }
    await this.bindSerial;
    await this.running;
    await this.owner.release();
  }
}

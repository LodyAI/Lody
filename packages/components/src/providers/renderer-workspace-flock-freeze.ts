import type { LoroRepo } from 'loro-repo';
import type { WorkspaceWriter } from './workspace-writer';
import type {
  WorkspaceCatalogReader,
  WorkspaceCatalogCommands,
  WorkspaceCatalogObservation,
} from '@lody/shared';
import {
  rendererWfBindingKey,
  rendererWfRequestSchema,
  rendererWfOwnerSchema,
  type RendererWfBinding,
  type RendererWfOwner,
  type RendererWfRequest,
  type RendererWfAck,
  type RendererWfPublishedOwner,
} from '@lody/shared/renderer-room-migration';
import { captureFrozenRendererWorkspaceFlockSources } from './renderer-workspace-flock-migration';
import type { WorkspaceId } from '@lody/shared';

export type RendererWorkspaceFlockMigrationPort = {
  /** Subscribe first, register this trusted window, then ready-handshake for a fresh persistent owner. */
  start(
    binding: RendererWfBinding,
    onRequest: (request: RendererWfRequest) => Promise<RendererWfAck>,
    signal?: AbortSignal,
    onOwner?: (owner: RendererWfPublishedOwner) => void
  ): Promise<{
    owner: RendererWfOwner;
    registrationId: string;
    close(): void | Promise<void>;
  }>;
};

/** One renderer-runtime generation; all catalog reads/writes/sync share this admission. */
export class RendererWorkspaceFlockFreeze {
  private owner: RendererWfOwner | undefined;
  private blocked = true;
  private active = 0;
  private readonly idle = new Set<() => void>();
  private readonly observers = new Set<WorkspaceCatalogObservation>();
  private readonly cleanup = new Set<WorkspaceCatalogObservation>();
  private freezeAttempt: Promise<void> | undefined;
  private disposed = false;
  private hadLegacy = false;
  private revision = 0;
  private readonly ownerListeners = new Set<() => void>();
  ownerKind() {
    return this.owner?.owner ?? 'frozen';
  }
  subscribeOwner(listener: () => void) {
    this.ownerListeners.add(listener);
    return () => {
      this.ownerListeners.delete(listener);
    };
  }
  private emitOwner() {
    for (const listener of this.ownerListeners) listener();
  }
  published(owner: RendererWfPublishedOwner): void {
    if (this.disposed || rendererWfBindingKey(owner.binding) !== rendererWfBindingKey(this.binding))
      throw new Error('Native owner publication binding retired');
    if (this.owner && (this.owner.owner === 'legacy' || this.owner.revision !== owner.revision))
      throw new Error('Native owner publication revision mismatch');
    this.revision++;
    this.owner = owner;
    this.blocked = true;
    this.emitOwner();
  }
  constructor(
    readonly binding: RendererWfBinding,
    private readonly ports: {
      readStartupOwner(): Promise<RendererWfOwner>;
      detachRoom(): Promise<void>;
      persistRoom(): Promise<void>;
      indexedDB?: IDBFactory;
    }
  ) {}
  async startup(): Promise<RendererWfOwner> {
    if (this.disposed) throw new Error('Renderer WF owner is disposed');
    const revision = this.revision;
    const owner = rendererWfOwnerSchema.parse(await this.ports.readStartupOwner());
    if (rendererWfBindingKey(owner.binding) !== rendererWfBindingKey(this.binding))
      throw new Error('Renderer WF startup binding mismatch');
    if (this.disposed) throw new Error('Renderer WF owner is disposed');
    if (this.revision !== revision && this.owner) return this.owner;
    this.owner = owner;
    this.blocked = owner.owner !== 'legacy';
    this.hadLegacy ||= owner.owner === 'legacy';
    this.emitOwner();
    return owner;
  }
  isLegacy(): boolean {
    return !this.blocked && !this.disposed && this.owner?.owner === 'legacy';
  }
  private lease() {
    if (!this.isLegacy()) throw new Error('Renderer WF legacy admission is frozen');
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      if (!this.active) for (const wake of this.idle) wake();
    };
  }
  async run<A>(work: () => A | Promise<A>): Promise<A> {
    const release = this.lease();
    try {
      return await work();
    } finally {
      release();
    }
  }
  reader(reader: WorkspaceCatalogReader): WorkspaceCatalogReader {
    return {
      read: (binding) => this.run(() => reader.read(binding)),
      observe: async (binding, update, error) => {
        const release = this.lease();
        let underlying: WorkspaceCatalogObservation;
        try {
          underlying = await reader.observe(binding, update, error);
        } catch (cause) {
          release();
          throw cause;
        }
        let done = false;
        let closing: Promise<void> | undefined;
        const close = (): Promise<void> => {
          if (done) return Promise.resolve();
          if (closing) return closing;
          this.cleanup.add(observation);
          closing = Promise.resolve()
            .then(() => underlying.close())
            .then(() => {
              done = true;
              this.cleanup.delete(observation);
              this.observers.delete(observation);
              release();
            })
            .finally(() => {
              closing = undefined;
            });
          return closing;
        };
        const observation = { close };
        this.observers.add(observation);
        if (this.blocked || this.disposed) await observation.close();
        return observation;
      },
    };
  }
  commands(commands: WorkspaceCatalogCommands): WorkspaceCatalogCommands {
    return {
      execute: (binding, command, options) =>
        this.run(() => commands.execute(binding, command, options)),
      upload: (binding) => this.run(() => commands.upload(binding)),
    };
  }
  writer(writer: WorkspaceWriter): WorkspaceWriter {
    const wrap = <A>(roomId: string, work: () => Promise<A>) =>
      roomId === this.binding.roomId ? this.run(work) : work();
    return {
      ...writer,
      flockRowPut: (id, key, value) => wrap(id, () => writer.flockRowPut(id, key, value)),
      flockRowDelete: (id, key) => wrap(id, () => writer.flockRowDelete(id, key)),
      flockRowUpdate: (id, key, plan) => wrap(id, () => writer.flockRowUpdate(id, key, plan)),
      flockRowPutIfAbsent: (id, key, value) =>
        wrap(id, () => writer.flockRowPutIfAbsent(id, key, value)),
    };
  }
  /** Capture only after main has received freeze ACKs from every registered window. */
  async handle(message: RendererWfRequest): Promise<RendererWfAck> {
    const request = rendererWfRequestSchema.parse(message);
    if (rendererWfBindingKey(request.binding) !== rendererWfBindingKey(this.binding))
      throw new Error('Renderer WF freeze binding mismatch');
    if (this.disposed) throw new Error('Renderer WF owner is disposed');
    if (request.phase === 'freeze') {
      this.revision++;
      this.blocked = true;
      this.owner = { binding: this.binding, owner: 'frozen', revision: request.revision };
      this.emitOwner();
      if (!this.freezeAttempt)
        this.freezeAttempt = this.freeze().catch((cause) => {
          this.freezeAttempt = undefined;
          throw cause;
        });
      await this.freezeAttempt;
      if (this.disposed) throw new Error('Renderer WF owner retired before freeze acknowledgement');
      return { ...request };
    }
    if (
      this.owner?.owner !== 'frozen' ||
      this.owner.revision !== request.revision ||
      !this.freezeAttempt
    )
      throw new Error('Renderer WF capture requires its completed freeze generation');
    await this.freezeAttempt;
    const sources = await captureFrozenRendererWorkspaceFlockSources({
      workspaceId: this.binding.workspaceId as WorkspaceId,
      contentMode: 'plaintext',
      indexedDB: this.ports.indexedDB,
      freezeAndDrainAllWindows: async () => {}, // Main's all-window barrier precedes this phase.
    });
    if (this.disposed || this.owner.revision !== request.revision)
      throw new Error('Renderer WF capture generation retired');
    return {
      ...request,
      sources: sources.map((source) => ({ ...source, snapshot: Uint8Array.from(source.snapshot) })),
    };
  }
  private async freeze(): Promise<void> {
    const failures: unknown[] = [];
    // Admission is already closed: close live domain observers, then detach SDK
    // live/background room traffic before waiting for admitted operations.
    const observers = await Promise.allSettled(
      [...new Set([...this.observers, ...this.cleanup])].map((observer) => observer.close())
    );
    for (const result of observers) if (result.status === 'rejected') failures.push(result.reason);
    try {
      if (this.hadLegacy) await this.ports.detachRoom();
    } catch (cause) {
      failures.push(cause);
    }
    if (failures.length) throw new AggregateError(failures, 'Renderer WF freeze cleanup failed');
    if (this.active)
      await new Promise<void>((resolve) => {
        const wake = () => {
          if (!this.active) {
            this.idle.delete(wake);
            resolve();
          }
        };
        this.idle.add(wake);
        wake();
      });
    if (this.hadLegacy) await this.ports.persistRoom();
  }
  async close(): Promise<void> {
    this.blocked = true;
    this.disposed = true;
    await this.freeze();
  }
}

/** SDK 0.25 per-room detach plus durable complete binary flush; no unload/rebind. */
export function createRendererWfRepoFreezePorts(repo: LoroRepo, roomId: string) {
  return {
    async detachRoom() {
      await repo.refreshTransportRoutes();
    },
    async persistRoom() {
      if (!(await repo.getFlockDoc(roomId))) {
        return;
      }
      const lease = await repo.acquireFlockDoc(roomId);
      try {
        lease.flock.commit();
        await repo.persistFlockDocNow(roomId, lease.flock);
      } finally {
        await lease.release();
      }
    },
  };
}

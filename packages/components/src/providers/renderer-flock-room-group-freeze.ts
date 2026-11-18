import { inspectRendererMachineCatalogOwners } from './renderer-machine-catalog-inventory';
import type { LoroRepo } from 'loro-repo';
import type { WorkspaceWriter } from './workspace-writer';
import {
  rendererFlockGroupSchema,
  rendererFlockGroupKey,
  rendererFlockGroupOwnerSchema,
  rendererFlockGroupRegistrationSchema,
  rendererFlockGroupRequestSchema,
  type RendererFlockGroup,
  type RendererFlockGroupOwner,
  type RendererFlockGroupRequest,
  type RendererFlockGroupAck,
  type RendererFlockGroupRegistration,
} from '@lody/shared/renderer-flock-room-group';
import { captureFrozenRendererFlockRoomGroup } from './renderer-flock-room-group-capture';

type Observation = { close(): void | Promise<void> };
/**
 * Borrowed legacy resources only. Composition must wrap every selected room's
 * open/read/write/persistence and observer, and use shouldRoute in its SDK router.
 * Constructing this gate alone does not freeze an unwrapped producer.
 */
export class RendererFlockRoomGroupFreeze {
  readonly group: RendererFlockGroup;
  private readonly roomIds: Set<string>;
  private owner: RendererFlockGroupOwner | undefined;
  private blocked = true;
  private disposed = false;
  private active = 0;
  private hadLegacy = false;
  private generation = 0;
  private registrationId: string | undefined;
  private readonly idle = new Set<() => void>();
  private readonly observers = new Set<Observation>();
  private readonly observerFailures = new Map<Observation, unknown>();
  private freezing: Promise<void> | undefined;
  private readonly ownerListeners = new Set<() => void>();
  subscribeOwner(listener: () => void) {
    this.ownerListeners.add(listener);
    return () => {
      this.ownerListeners.delete(listener);
    };
  }
  private emitOwner() {
    for (const listener of this.ownerListeners) listener();
  }
  constructor(
    group: RendererFlockGroup,
    private readonly ports: {
      readStartupOwner(): Promise<RendererFlockGroupOwner>;
      detachRooms(): Promise<void>;
      persistRooms(): Promise<void>;
      indexedDB?: IDBFactory;
      requireSingleMachine?: boolean;
    }
  ) {
    this.group = rendererFlockGroupSchema.parse(group);
    Object.freeze(this.group.roomIds);
    Object.freeze(this.group);
    this.roomIds = new Set(this.group.roomIds);
  }
  async startup(): Promise<RendererFlockGroupOwner> {
    if (this.disposed) throw new Error('Room group owner retired');
    const generation = this.generation;
    const owner = rendererFlockGroupOwnerSchema.parse(await this.ports.readStartupOwner());
    if (this.disposed || rendererFlockGroupKey(owner.group) !== rendererFlockGroupKey(this.group))
      throw new Error('Room group startup identity retired');
    if (generation !== this.generation && this.owner) return this.owner;
    this.owner = owner;
    this.blocked = owner.owner !== 'legacy';
    this.hadLegacy ||= owner.owner === 'legacy';
    this.emitOwner();
    return owner;
  }
  /** Bind the trusted register response BEFORE ready(), which may start a freeze. */
  bindRegistration(registrationId: string): void {
    const parsed = rendererFlockGroupRegistrationSchema.shape.registrationId.parse(registrationId);
    if (this.disposed || (this.registrationId && this.registrationId !== parsed))
      throw new Error('Room group renderer registration retired');
    this.registrationId = parsed;
  }
  /** Unselected rooms remain available; selected startup/native/frozen rooms never join legacy. */
  shouldRoute(roomId: string): boolean {
    return (
      !this.roomIds.has(roomId) ||
      (!this.blocked && !this.disposed && this.owner?.owner === 'legacy')
    );
  }
  ownerKind() {
    return this.owner?.owner ?? 'frozen';
  }
  private lease(roomId: string) {
    if (!this.roomIds.has(roomId)) return () => {};
    if (!this.shouldRoute(roomId)) throw new Error('Selected legacy room group is frozen');
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      if (!this.active) for (const wake of this.idle) wake();
    };
  }
  async run<A>(roomId: string, work: () => A | Promise<A>): Promise<A> {
    const release = this.lease(roomId);
    try {
      return await work();
    } finally {
      release();
    }
  }
  async observe<A>(
    roomId: string,
    open: (update: (value: A) => void) => Promise<Observation>,
    update: (value: A) => void
  ): Promise<Observation> {
    const release = this.lease(roomId);
    let underlying: Observation;
    try {
      underlying = await open((value) => {
        if (this.shouldRoute(roomId)) update(value);
      });
    } catch (cause) {
      release();
      throw cause;
    }
    let done = false;
    let closing: Promise<void> | undefined;
    const observation = {
      close: (): Promise<void> => {
        if (done) return Promise.resolve();
        if (closing) return closing;
        closing = Promise.resolve()
          .then(() => underlying.close())
          .then(() => {
            done = true;
            this.observers.delete(observation);
            this.observerFailures.delete(observation);
            release();
          })
          .catch((cause) => {
            if (this.roomIds.has(roomId)) {
              this.observerFailures.set(observation, cause);
              for (const wake of this.idle) wake();
            }
            throw cause;
          })
          .finally(() => {
            closing = undefined;
          });
        return closing;
      },
    };
    if (this.roomIds.has(roomId)) this.observers.add(observation);
    if (!this.shouldRoute(roomId)) await observation.close();
    return observation;
  }
  writer(writer: WorkspaceWriter): WorkspaceWriter {
    return {
      ...writer,
      flockRowPut: (id, key, value) => this.run(id, () => writer.flockRowPut(id, key, value)),
      flockRowDelete: (id, key) => this.run(id, () => writer.flockRowDelete(id, key)),
      flockRowUpdate: (id, key, plan) => this.run(id, () => writer.flockRowUpdate(id, key, plan)),
      flockRowPutIfAbsent: (id, key, value) =>
        this.run(id, () => writer.flockRowPutIfAbsent(id, key, value)),
    };
  }
  async handle(message: RendererFlockGroupRequest): Promise<RendererFlockGroupAck> {
    const request = rendererFlockGroupRequestSchema.parse(message);
    if (
      this.disposed ||
      !this.registrationId ||
      request.registrationId !== this.registrationId ||
      rendererFlockGroupKey(request.group) !== rendererFlockGroupKey(this.group)
    )
      throw new Error('Room group freeze identity retired');
    if (request.phase === 'preflight') {
      if (this.owner?.owner !== 'legacy') throw new Error('MF preflight requires legacy owner');
      return {
        ...request,
        otherMachineOwners: await inspectRendererMachineCatalogOwners(
          this.group,
          this.ports.indexedDB
        ),
      };
    }
    if (request.phase === 'freeze') {
      if (this.owner?.owner === 'native') throw new Error('Legacy room group is already retired');
      this.generation++;
      this.blocked = true; // Synchronous across the whole exact set, before any await.
      this.owner = { group: this.group, owner: 'frozen', revision: request.revision };
      this.emitOwner();
      if (!this.freezing)
        this.freezing = this.drain().catch((cause) => {
          this.freezing = undefined;
          throw cause;
        });
      await this.freezing;
    } else {
      if (
        !this.freezing ||
        this.owner?.owner !== 'frozen' ||
        this.owner.revision !== request.revision
      )
        throw new Error('Room group capture requires its completed freeze generation');
      await this.freezing;
      if (
        this.ports.requireSingleMachine &&
        this.group.domain === 'machine' &&
        (await inspectRendererMachineCatalogOwners(this.group, this.ports.indexedDB)).length
      )
        throw new Error('MF single-machine inventory changed after preflight');
      const inventory = await captureFrozenRendererFlockRoomGroup({
        group: this.group,
        indexedDB: this.ports.indexedDB,
        freezeAndDrainAllWindows: async () => {}, // Main has awaited every exact participant.
      });
      if (this.disposed || this.owner.revision !== request.revision)
        throw new Error('Room group capture generation retired');
      return { ...request, inventory };
    }
    if (this.disposed || this.owner?.revision !== request.revision)
      throw new Error('Room group freeze generation retired');
    return { ...request };
  }
  /** Keeps legacy admission closed after the trusted main's whole-group commit. */
  published(ownerInput: RendererFlockGroupRegistration): void {
    const owner = rendererFlockGroupRegistrationSchema.parse(ownerInput);
    if (
      this.disposed ||
      owner.registrationId !== this.registrationId ||
      owner.owner !== 'native' ||
      !this.owner ||
      this.owner.owner === 'legacy' ||
      this.owner.revision !== owner.revision ||
      rendererFlockGroupKey(owner.group) !== rendererFlockGroupKey(this.group)
    )
      throw new Error('Room group publication does not match its freeze');
    this.generation++;
    this.owner = { group: owner.group, revision: owner.revision, owner: owner.owner };
    this.hadLegacy = false; // The completed freeze is the final old persistence barrier.
    this.blocked = true;
    this.emitOwner();
  }
  private async drain(): Promise<void> {
    const results = await Promise.allSettled([
      ...[...this.observers].map((observer) => observer.close()),
      ...(this.hadLegacy ? [Promise.resolve().then(() => this.ports.detachRooms())] : []),
    ]);
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    );
    if (errors.length)
      throw new AggregateError(errors, 'Room group observer/transport drain failed');
    if (this.active)
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          if (this.observerFailures.size) {
            this.idle.delete(wake);
            reject(
              new AggregateError(
                [...this.observerFailures.values()],
                'Late room group observer release failed'
              )
            );
          } else if (!this.active) {
            this.idle.delete(wake);
            resolve();
          }
        };
        this.idle.add(wake);
        wake();
      });
    if (this.hadLegacy) await this.ports.persistRooms();
  }
  async close(): Promise<void> {
    this.disposed = true;
    this.blocked = true;
    await this.drain();
  }
}

/** The runtime's transport router MUST also consult gate.shouldRoute for all selected rooms. */
export function createRendererFlockGroupRepoFreezePorts(repo: LoroRepo, group: RendererFlockGroup) {
  const selected = rendererFlockGroupSchema.parse(group);
  return {
    detachRooms: () => repo.refreshTransportRoutes(),
    async persistRooms() {
      const results = await Promise.allSettled(
        selected.roomIds.map(async (roomId) => {
          if (!(await repo.getFlockDoc(roomId))) return;
          const lease = await repo.acquireFlockDoc(roomId);
          try {
            lease.flock.commit();
            await repo.persistFlockDocNow(roomId, lease.flock);
          } finally {
            await lease.release();
          }
        })
      );
      const errors = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      );
      if (errors.length) throw new AggregateError(errors, 'Room group persistence barrier failed');
    },
  };
}

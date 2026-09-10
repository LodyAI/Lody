import { EphemeralStore, type Value } from 'loro-crdt';
import {
  LODY_MACHINE_MONITOR_OBSERVER_RENEW_MS,
  LODY_MACHINE_MONITOR_OBSERVER_TTL_MS,
  LODY_MACHINE_MONITOR_STATE_TTL_MS,
  findLatestMachineMonitorSnapshot,
  getMachineMonitorObserverKey,
  getServerNow,
  parseMachineMonitorStates,
  toLodyMachineMonitorStreamUrl,
  type MachineId,
  type MachineMonitorObserverState,
  type MachineMonitorSnapshot,
} from '@lody/shared';
import {
  EphemeralRoomTransport,
  type EphemeralRoomStartArgs,
  type EphemeralRoomBaseOptions,
  type EphemeralRoomStoreLike,
} from './ephemeral-room-transport';

type SnapshotListener = (snapshot: MachineMonitorSnapshot | null) => void;

type MonitorStoreLike = EphemeralRoomStoreLike & {
  set(key: string, value: Value): void;
  delete(key: string): void;
};

export class WorkspaceMachineMonitorTransport extends EphemeralRoomTransport<
  MonitorStoreLike,
  EphemeralRoomBaseOptions
> {
  protected readonly warnPrefix = 'WorkspaceMachineMonitorTransport';
  protected readonly roomLabel = 'machine monitor room';
  private readonly observerId = createObserverId();
  private readonly listeners = new Map<MachineId, Set<SnapshotListener>>();
  private readonly renewalTimers = new Map<MachineId, ReturnType<typeof setInterval>>();
  private readonly forceSampleAtByMachine = new Map<MachineId, number>();
  private startArgs: EphemeralRoomStartArgs | null = null;

  /**
   * Retain connection credentials while the workspace is attached, but do not
   * join the ephemeral room until a consumer needs a machine snapshot.
   */
  override start(args: EphemeralRoomStartArgs): void {
    this.startArgs = args;
    if (this.listeners.size > 0) super.start(args);
  }

  override async stop(): Promise<void> {
    this.startArgs = null;
    await super.stop();
  }

  shouldRestartOnExternalWake(nowMs: number = getServerNow()): boolean {
    const syncState = this.getSyncState();
    if (syncState === 'idle') return false;
    if (syncState !== 'synced') return true;
    if (this.listeners.size === 0) return false;
    for (const machineId of this.listeners.keys()) {
      const snapshot = this.getSnapshot(machineId);
      if (!snapshot || nowMs - snapshot.updatedAtMs >= 30_000) return true;
    }
    return false;
  }

  subscribeMachine(machineId: MachineId, listener: SnapshotListener): () => void {
    let machineListeners = this.listeners.get(machineId);
    if (!machineListeners) {
      machineListeners = new Set();
      this.listeners.set(machineId, machineListeners);
    }
    machineListeners.add(listener);
    listener(this.getSnapshot(machineId));
    this.startRenewal(machineId);
    this.startIfObserved();
    this.publishObserver(machineId, null);
    return () => {
      const current = this.listeners.get(machineId);
      current?.delete(listener);
      if (current && current.size > 0) return;
      this.listeners.delete(machineId);
      const timer = this.renewalTimers.get(machineId);
      if (timer) clearInterval(timer);
      this.renewalTimers.delete(machineId);
      this.forceSampleAtByMachine.delete(machineId);
      this.store?.delete(getMachineMonitorObserverKey(machineId, this.observerId));
      if (this.listeners.size === 0) void super.stop();
    };
  }

  forceSample(machineId: MachineId): void {
    if (!this.listeners.has(machineId)) return;
    const forceSampleAtMs = getServerNow();
    this.forceSampleAtByMachine.set(machineId, forceSampleAtMs);
    this.publishObserver(machineId, forceSampleAtMs);
  }

  protected createStore(): MonitorStoreLike {
    return new EphemeralStore(LODY_MACHINE_MONITOR_STATE_TTL_MS);
  }

  protected tagStreamUrl(durableStreamUrl: string): string {
    return toLodyMachineMonitorStreamUrl(durableStreamUrl);
  }

  protected onStoreChange(): void {
    this.emitSnapshots();
  }

  protected override onRoomStarted(): void {
    for (const machineId of this.listeners.keys()) this.startRenewal(machineId);
    this.publishAllObservers();
  }

  protected override onJoined(): void {
    this.publishAllObservers();
    this.emitSnapshots();
  }

  protected override onBeforeTeardown(): void {
    for (const timer of this.renewalTimers.values()) clearInterval(timer);
    this.renewalTimers.clear();
    for (const machineId of this.listeners.keys()) {
      this.store?.delete(getMachineMonitorObserverKey(machineId, this.observerId));
    }
  }

  private startRenewal(machineId: MachineId): void {
    if (this.renewalTimers.has(machineId)) return;
    const timer = setInterval(
      () => this.publishObserver(machineId, null),
      LODY_MACHINE_MONITOR_OBSERVER_RENEW_MS
    );
    this.renewalTimers.set(machineId, timer);
  }

  private startIfObserved(): void {
    if (this.getSyncState() !== 'idle' || !this.startArgs) return;
    super.start(this.startArgs);
  }

  private publishObserver(machineId: MachineId, forceSampleAtMs: number | null): void {
    if (!this.store) return;
    const nowMs = getServerNow();
    const state: MachineMonitorObserverState = {
      kind: 'observer',
      protocolVersion: 1,
      machineId,
      observerId: this.observerId,
      updatedAtMs: nowMs,
      expiresAtMs: nowMs + LODY_MACHINE_MONITOR_OBSERVER_TTL_MS,
      forceSampleAtMs: forceSampleAtMs ?? this.forceSampleAtByMachine.get(machineId) ?? null,
    };
    this.store.set(
      getMachineMonitorObserverKey(machineId, this.observerId),
      state as unknown as Value
    );
  }

  private publishAllObservers(): void {
    for (const machineId of this.listeners.keys()) this.publishObserver(machineId, null);
  }

  private emitSnapshots(): void {
    if (!this.store) return;
    const states = parseMachineMonitorStates(this.store.getAllStates());
    for (const [machineId, listeners] of this.listeners) {
      const snapshot = findLatestMachineMonitorSnapshot(states, machineId);
      for (const listener of Array.from(listeners)) listener(snapshot);
    }
  }

  private getSnapshot(machineId: MachineId): MachineMonitorSnapshot | null {
    if (!this.store) return null;
    return findLatestMachineMonitorSnapshot(
      parseMachineMonitorStates(this.store.getAllStates()),
      machineId
    );
  }
}

function createObserverId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

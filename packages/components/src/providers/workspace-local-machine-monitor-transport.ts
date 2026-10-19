import { EphemeralStore, type Value } from 'loro-crdt';
import {
  LODY_MACHINE_MONITOR_OBSERVER_RENEW_MS,
  LODY_MACHINE_MONITOR_OBSERVER_TTL_MS,
  LODY_MACHINE_MONITOR_STATE_TTL_MS,
  LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
  base64ToBytes,
  bytesToBase64,
  findLatestMachineMonitorSnapshot,
  getMachineMonitorObserverKey,
  getServerNow,
  parseMachineMonitorStates,
  type MachineId,
  type MachineMonitorObserverState,
  type MachineMonitorSnapshot,
  type WorkspaceId,
} from '@lody/shared';
import type { LocalLoroDataPlaneConnection } from '@lody/shared/local-loro-transport';

type SnapshotListener = (snapshot: MachineMonitorSnapshot | null) => void;

export class WorkspaceLocalMachineMonitorTransport {
  private readonly observerId = createObserverId();
  private readonly outboundStore = new EphemeralStore(LODY_MACHINE_MONITOR_STATE_TTL_MS);
  private readonly snapshotStore = new EphemeralStore(LODY_MACHINE_MONITOR_STATE_TTL_MS);
  private readonly listeners = new Map<MachineId, Set<SnapshotListener>>();
  private readonly renewalTimers = new Map<MachineId, ReturnType<typeof setInterval>>();
  private readonly forceSampleAtByMachine = new Map<MachineId, number>();
  private readonly unsubscribeMessage: () => void;
  private readonly unsubscribeStatus: () => void;
  private stopped = false;

  constructor(
    private readonly options: {
      workspaceId: WorkspaceId;
      peerId: string;
      connection: LocalLoroDataPlaneConnection;
    }
  ) {
    this.unsubscribeMessage = options.connection.onMessage((message) => {
      if (message.type !== 'machine-monitor' || message.workspaceId !== options.workspaceId) return;
      this.snapshotStore.apply(base64ToBytes(message.dataBase64));
      this.emitSnapshots();
    });
    this.unsubscribeStatus = options.connection.onStatusChange((connected) => {
      if (connected && this.listeners.size > 0) this.publishState();
    });
  }

  subscribeMachine(machineId: MachineId, listener: SnapshotListener): () => void {
    let machineListeners = this.listeners.get(machineId);
    if (!machineListeners) {
      machineListeners = new Set();
      this.listeners.set(machineId, machineListeners);
      this.startRenewal(machineId);
    }
    machineListeners.add(listener);
    listener(this.getSnapshot(machineId));
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
      this.outboundStore.delete(getMachineMonitorObserverKey(machineId, this.observerId));
      this.publishState();
    };
  }

  forceSample(machineId: MachineId): void {
    if (!this.listeners.has(machineId)) return;
    const forceSampleAtMs = getServerNow();
    this.forceSampleAtByMachine.set(machineId, forceSampleAtMs);
    this.publishObserver(machineId, forceSampleAtMs);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const timer of this.renewalTimers.values()) clearInterval(timer);
    this.renewalTimers.clear();
    this.listeners.clear();
    this.unsubscribeMessage();
    this.unsubscribeStatus();
    this.outboundStore.destroy();
    this.snapshotStore.destroy();
  }

  private startRenewal(machineId: MachineId): void {
    const timer = setInterval(
      () => this.publishObserver(machineId, null),
      LODY_MACHINE_MONITOR_OBSERVER_RENEW_MS
    );
    this.renewalTimers.set(machineId, timer);
  }

  private publishObserver(machineId: MachineId, forceSampleAtMs: number | null): void {
    if (this.stopped) return;
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
    this.outboundStore.set(
      getMachineMonitorObserverKey(machineId, this.observerId),
      state as unknown as Value
    );
    this.publishState();
  }

  private publishState(): void {
    if (this.stopped || !this.options.connection.isConnected()) return;
    try {
      this.options.connection.send({
        type: 'machine-monitor',
        protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
        workspaceId: this.options.workspaceId,
        peerId: this.options.peerId,
        dataBase64: bytesToBase64(this.outboundStore.encodeAll()),
      });
    } catch {
      // The status edge resends the current observer bundle after reconnect.
    }
  }

  private emitSnapshots(): void {
    for (const [machineId, listeners] of this.listeners) {
      const snapshot = this.getSnapshot(machineId);
      for (const listener of Array.from(listeners)) listener(snapshot);
    }
  }

  private getSnapshot(machineId: MachineId): MachineMonitorSnapshot | null {
    return findLatestMachineMonitorSnapshot(
      parseMachineMonitorStates(this.snapshotStore.getAllStates()),
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

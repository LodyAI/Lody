import { EphemeralStore, type Value } from 'loro-crdt';
import {
  LODY_PRESENCE_TTL_MS,
  getLodyMachinePresenceKey,
  getLodySessionPresenceKey,
  parseLodyPresenceStates,
  type LodyPresenceInstanceId,
  type LodyPresenceState,
  type LodyPresenceStateMap,
  type LodySessionPresenceState,
  type MachineId,
  type SessionId,
  type SessionStatus,
} from '@lody/shared';

/** Synchronous CRDT state. Only the workspace owner destroys these stores. */
export class PresenceReplica {
  readonly store = new EphemeralStore(LODY_PRESENCE_TTL_MS);
  private readonly local = new EphemeralStore(LODY_PRESENCE_TTL_MS);
  private readonly listeners = new Set<() => void>();
  private readonly sessions = new Map<SessionId, string>();
  private machineId: MachineId | undefined;
  private machineKey: string | undefined;
  private closed = false;
  private encrypted = false;
  private destroyed = false;

  constructor(readonly instanceId: LodyPresenceInstanceId) {}

  private write(key: string, state: LodyPresenceState): void {
    if (this.closed) return;
    this.store.set(key, state as unknown as Value);
    this.local.set(key, state as unknown as Value);
    for (const listener of this.listeners) listener();
  }
  private remove(key: string): void {
    this.store.delete(key);
    this.local.delete(key);
    for (const listener of this.listeners) listener();
  }
  setMachineOnline(machineId: MachineId, now: number): void {
    if (this.closed) return;
    this.machineId = machineId;
    this.machineKey = getLodyMachinePresenceKey(machineId, this.instanceId);
    this.heartbeat(now);
  }
  heartbeat(now: number): boolean {
    if (this.closed || !this.machineId || !this.machineKey) return false;
    this.write(this.machineKey, {
      kind: 'machine',
      machineId: this.machineId,
      instanceId: this.instanceId,
      updatedAt: now,
    });
    return true;
  }
  setSessionPresence(
    args: {
      sessionId: SessionId;
      machineId: MachineId | undefined;
      status: SessionStatus | undefined;
    },
    now: number
  ): void {
    if (this.closed) return;
    if (!args.status || args.status.type === 'idle')
      return this.clearSessionPresence(args.sessionId);
    const machineId = args.machineId ?? this.machineId;
    if (!machineId) return;
    const key = getLodySessionPresenceKey(args.sessionId, this.instanceId);
    this.sessions.set(args.sessionId, key);
    this.write(key, {
      kind: 'session',
      sessionId: args.sessionId,
      machineId,
      instanceId: this.instanceId,
      status: args.status,
      updatedAt: now,
    });
  }
  clearSessionPresence(sessionId: SessionId): void {
    if (this.closed) return;
    const key = this.sessions.get(sessionId);
    if (!key) return;
    this.sessions.delete(sessionId);
    this.remove(key);
  }
  republish(now: number): void {
    this.heartbeat(now);
    for (const key of this.sessions.values()) {
      const state = this.local.get(key) as LodySessionPresenceState | undefined;
      if (state) this.write(key, { ...state, updatedAt: now });
    }
  }
  useEncryptedPresence(): void {
    this.encrypted = true;
  }
  getPresenceStates(): LodyPresenceStateMap {
    return parseLodyPresenceStates(
      this.store.getAllStates() as Record<string, unknown>,
      this.encrypted ? { authenticatedExpiry: true } : undefined
    );
  }
  encodeLocalOriginPresence(): Uint8Array {
    return this.local.encodeAll();
  }
  subscribeLocalOriginPresence(listener: () => void): () => void {
    if (this.closed) return () => {};
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  subscribe(listener: (states: LodyPresenceStateMap) => void): () => void {
    if (this.closed) return () => {};
    return this.store.subscribe(() => {
      listener(this.getPresenceStates());
    });
  }
  private clearOwned(): void {
    if (this.machineKey) this.remove(this.machineKey);
    this.machineKey = undefined;
    this.machineId = undefined;
    for (const [sessionId, key] of [...this.sessions]) {
      this.remove(key);
      this.sessions.delete(sessionId);
    }
  }
  clear(): void {
    if (this.closed) return;
    this.clearOwned();
  }
  retire(): void {
    this.closed = true;
    this.clearOwned();
  }
  destroy(): void {
    if (this.destroyed) return;
    this.closed = true;
    this.listeners.clear();
    this.store.destroy();
    this.local.destroy();
    this.destroyed = true;
  }
}

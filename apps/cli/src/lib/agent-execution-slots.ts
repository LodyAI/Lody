/** Host-local Schedule admission per Agent config. No distributed lease. */
export class AgentExecutionSlots {
  private readonly reservations = new Map<string, Set<string>>();
  private readonly listeners = new Set<(releasedOwner?: string) => void>();

  isBusy(agentConfigId: string, ownReservation?: string): boolean {
    return [...(this.reservations.get(agentConfigId) ?? [])].some(
      (owner) => owner !== ownReservation
    );
  }

  reserve(agentConfigId: string, owner: string): boolean {
    if (this.isBusy(agentConfigId, owner)) return false;
    this.restore(agentConfigId, owner);
    return true;
  }

  /** Recovery can restore multiple already-accepted Sessions without pretending they disappeared. */
  restore(agentConfigId: string, owner: string): void {
    const owners = this.reservations.get(agentConfigId) ?? new Set<string>();
    owners.add(owner);
    this.reservations.set(agentConfigId, owners);
  }

  release(agentConfigId: string, owner: string): void {
    const owners = this.reservations.get(agentConfigId);
    if (!owners?.delete(owner)) return;
    if (!owners.size) this.reservations.delete(agentConfigId);
    this.changed(owner);
  }

  subscribe(listener: (releasedOwner?: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private changed(releasedOwner?: string): void {
    for (const listener of this.listeners) listener(releasedOwner);
  }
}

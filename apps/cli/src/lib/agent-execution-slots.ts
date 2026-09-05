/** Host-local admission shared by delegated Tasks and Schedules. No distributed lease. */
export class AgentExecutionSlots {
  private readonly reservations = new Map<string, Set<string>>();
  private readonly taskOwners = new Map<string, Set<string>>();
  private readonly listeners = new Set<(releasedOwner?: string) => void>();

  isBusy(agentConfigId: string, ownReservation?: string): boolean {
    return (
      (this.taskOwners.get(agentConfigId)?.size ?? 0) > 0 ||
      [...(this.reservations.get(agentConfigId) ?? [])].some((owner) => owner !== ownReservation)
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

  replaceTaskOccupancy(
    rows: readonly { agentConfigId?: string; taskId: string; status: string; ownerId: string }[],
    userId: string
  ): void {
    const previous = JSON.stringify(
      [...this.taskOwners].map(([id, owners]) => [id, [...owners].sort()]).sort()
    );
    this.taskOwners.clear();
    for (const row of rows) {
      if (row.status !== 'in_progress' || row.ownerId !== userId || !row.agentConfigId) continue;
      const owners = this.taskOwners.get(row.agentConfigId) ?? new Set<string>();
      owners.add(row.taskId);
      this.taskOwners.set(row.agentConfigId, owners);
    }
    const next = JSON.stringify(
      [...this.taskOwners].map(([id, owners]) => [id, [...owners].sort()]).sort()
    );
    if (previous !== next) this.changed();
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

/** A singleton in the machine Worker, shared by all workspace MessageHandlers. */
export class SimulatorControlLeases {
  private readonly owners = new Map<string, { owner: string; generation: string }>();
  occupancy(udid: string, owner: string): 'available' | 'this-session' | 'other-session' {
    const current = this.owners.get(udid.toUpperCase());
    return !current ? 'available' : current.owner === owner ? 'this-session' : 'other-session';
  }
  acquire(udid: string, owner: string, generation: string): boolean {
    const key = udid.toUpperCase();
    if (this.owners.has(key)) return false;
    this.owners.set(key, { owner, generation });
    return true;
  }
  owns(udid: string, owner: string, generation: string): boolean {
    const current = this.owners.get(udid.toUpperCase());
    return current?.owner === owner && current.generation === generation;
  }
  release(udid: string, owner: string, generation: string): void {
    if (this.owns(udid, owner, generation)) this.owners.delete(udid.toUpperCase());
  }
}
export const simulatorControlLeases = new SimulatorControlLeases();

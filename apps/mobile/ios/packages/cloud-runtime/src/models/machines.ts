export type MachineState = 'online' | 'offline' | 'unknown';
export type MachinePresence = {
  state: 'live' | 'unknown';
  onlineMachineIds: string[];
};

export const unknownPresence: MachinePresence = {
  state: 'unknown',
  onlineMachineIds: [],
};

export function machineState(
  presence: MachinePresence,
  id: string,
): MachineState {
  if (presence.state !== 'live') return 'unknown';
  return presence.onlineMachineIds.includes(id) ? 'online' : 'offline';
}

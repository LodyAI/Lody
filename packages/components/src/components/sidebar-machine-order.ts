import type { MachineId, MachineViewMeta } from '@lody/shared';

type SidebarMachine = Pick<MachineViewMeta, 'id' | 'name' | 'ownerUserId'>;

export function compareSidebarMachineOrder(
  left: SidebarMachine,
  right: SidebarMachine,
  lastKnownLocalMachineId: MachineId | null,
  currentUserId: string | null
): number {
  const byLocal =
    Number(right.id === lastKnownLocalMachineId) - Number(left.id === lastKnownLocalMachineId);
  const isTeammate = (machine: SidebarMachine) =>
    Boolean(currentUserId) && Boolean(machine.ownerUserId) && machine.ownerUserId !== currentUserId;
  const byOwner = Number(isTeammate(left)) - Number(isTeammate(right));
  return (
    byLocal || byOwner || left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
  );
}

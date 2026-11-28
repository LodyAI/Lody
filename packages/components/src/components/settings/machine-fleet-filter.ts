import type { MachineTabItem, MachineTabOwner } from './machine-tab-list';

export type MachineFleetFilterPreset = 'all' | 'online' | 'mine';

export type MachineFleetFilterCounts = {
  all: number;
  online: number;
  mine: number;
};

export function countMachineFleetFilters(
  items: readonly MachineTabItem[]
): MachineFleetFilterCounts {
  let online = 0;
  let mine = 0;
  for (const item of items) {
    if (item.isOnline) online += 1;
    if (item.isOwn) mine += 1;
  }
  return { all: items.length, online, mine };
}

export function filterMachineFleetItems(
  items: readonly MachineTabItem[],
  options: {
    preset: MachineFleetFilterPreset;
    query: string;
    ownerByUserId?: ReadonlyMap<string, MachineTabOwner>;
  }
): MachineTabItem[] {
  const normalizedQuery = options.query.trim().toLowerCase();
  return items.filter((item) => {
    if (options.preset === 'online' && !item.isOnline) return false;
    if (options.preset === 'mine' && !item.isOwn) return false;
    if (!normalizedQuery) return true;
    const ownerName = item.machine.ownerUserId
      ? (options.ownerByUserId?.get(item.machine.ownerUserId)?.name ?? '')
      : '';
    const haystack = [
      item.machine.name,
      item.machine.id,
      item.machine.os ?? '',
      item.machine.cliVersion ?? '',
      ownerName,
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(normalizedQuery);
  });
}

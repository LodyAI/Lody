import type { MachineId, MachineViewMeta } from '@lody/shared';
import type { MachineTabItem } from './machine-tab-list';

export type DesktopMachineSelection = {
  /** Machine the detail pane may render — always a member of the visible pool. */
  resolved: MachineViewMeta | undefined;
  /** Selection the caller should commit when it differs from the current one. */
  nextSelectedMachineId: MachineId | null;
};

/**
 * A direct settings shortcut must be able to open an owned private machine or a
 * shared machine hidden by the current list filter. Unshared machines owned by
 * somebody else remain outside the selectable workspace pool.
 */
export function buildWorkspaceMachineSelectionPool(args: {
  filteredItems: readonly MachineTabItem[];
  allItems: readonly MachineTabItem[];
  selectedMachineId: MachineId | null;
}): readonly MachineTabItem[] {
  const { filteredItems, allItems, selectedMachineId } = args;
  const selectedItem = selectedMachineId
    ? allItems.find(
        (item) =>
          item.machine.id === selectedMachineId && (item.sharedWithTeam || item.isOwn)
      )
    : undefined;
  if (
    !selectedItem ||
    filteredItems.some((item) => item.machine.id === selectedItem.machine.id)
  ) {
    return filteredItems;
  }
  return [selectedItem, ...filteredItems];
}

/**
 * Desktop settings invariant: the selected detail must stay visible in the pool
 * the machine selector renders (Machines: filtered tabItems; Agents: allItems).
 * When the current selection is filtered out — synchronously (filter toggles)
 * or asynchronously (an Online-filtered machine goes offline) — fall back to
 * the local machine, then the first own machine, then the first visible one;
 * an empty pool clears the selection so the prompt shows instead of a hidden
 * machine's detail.
 */
export function resolveDesktopMachineSelection(args: {
  pool: readonly MachineTabItem[];
  selectedMachineId: MachineId | null;
  localMachineId: MachineId | null;
}): DesktopMachineSelection {
  const { pool, selectedMachineId, localMachineId } = args;
  const byId = (id: MachineId | null): MachineViewMeta | undefined =>
    id ? pool.find((item) => item.machine.id === id)?.machine : undefined;

  const current = byId(selectedMachineId);
  if (current) {
    return { resolved: current, nextSelectedMachineId: selectedMachineId };
  }
  const fallback =
    byId(localMachineId) ?? pool.find((item) => item.isOwn)?.machine ?? pool[0]?.machine;
  return { resolved: fallback, nextSelectedMachineId: fallback?.id ?? null };
}

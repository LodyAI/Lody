import { atom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';
import type { ScheduleColumnWidths } from '@/components/schedules/schedule-list';
import type { ScheduleRegistryRow, ScheduleRuntimeRow, WorkspaceId } from '@lody/shared';

export const scheduleRegistryAtom = atom<{
  workspaceId: WorkspaceId | null;
  rows: ScheduleRegistryRow[];
  runtimes: ScheduleRuntimeRow[];
  ready: boolean;
  error?: string;
}>({ workspaceId: null, rows: [], runtimes: [], ready: false });

/** Schedule list column widths the person dragged; `null` = defaults. Per device. */
export const scheduleListColumnWidthsAtom = atomWithStorage<ScheduleColumnWidths | null>(
  'lody:scheduleListColumnWidths',
  null
);

/** List width while a schedule is open beside it; `null` = default. Per device. */
export const scheduleSplitListWidthAtom = atomWithStorage<number | null>(
  'lody:scheduleSplitListWidth',
  null
);

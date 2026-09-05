import { atom } from 'jotai';
import type { ScheduleRegistryRow, ScheduleRuntimeRow, WorkspaceId } from '@lody/shared';

export const scheduleRegistryAtom = atom<{
  workspaceId: WorkspaceId | null;
  rows: ScheduleRegistryRow[];
  runtimes: ScheduleRuntimeRow[];
  ready: boolean;
  error?: string;
}>({ workspaceId: null, rows: [], runtimes: [], ready: false });
export const openScheduleTabsAtom = atom<string[]>([]);

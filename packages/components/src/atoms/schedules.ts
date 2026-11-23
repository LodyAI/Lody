import { atom } from 'jotai';
import type { ScheduleRegistryRow, ScheduleRuntimeRow, WorkspaceId } from '@lody/shared';

export const scheduleRegistryAtom = atom<{
  workspaceId: WorkspaceId | null;
  rows: ScheduleRegistryRow[];
  runtimes: ScheduleRuntimeRow[];
  ready: boolean;
  error?: string;
  retrying?: boolean;
}>({ workspaceId: null, rows: [], runtimes: [], ready: false });

/** Explicit retries are handled by the one workspace-shell subscription. */
export const scheduleRegistryRetryAtom = atom(0);

import { useCallback, useMemo } from 'react';
import { atom, useAtom, type PrimitiveAtom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';

/**
 * Persisted filter / view state for the mobile home Chat tab.
 *
 * WHY: The pills above the Chat list were ephemeral `useState` and reset
 * whenever the user navigated away (or hot-reloaded). Carrying them
 * across navigations is the natural user expectation — they're filters,
 * not "tap to apply" actions. `chatScope` already lived in
 * `sidebar-state.ts` (shared with desktop); these five atoms cover the
 * mobile-only pills.
 *
 * Sets aren't JSON-serializable, so each exclusion atom stores a
 * `string[]`. Consumers go through `useMobileHomeExcludedSetAtom`
 * which presents the same `Set`-shaped API the previous `useState`
 * gave us — minimal blast radius at the call sites.
 */

/* The grouping mode for the Chat-tab list. Mirrors `MobileChatGroupBy`
   from `components/mobile/mobile-home-screen.tsx`. Re-declared here
   (rather than imported) so this atoms file stays free of React-only
   imports — keeping atoms framework-agnostic makes them cheaper to
   test and avoids a circular-import risk between atoms ↔ components. */
/* Home Chat Group pill: Project or Date only (No Group removed).
   `'none'` is not a valid stored value; older localStorage entries
   are coerced to `'project'` at the read site. */
export type MobileChatViewModeValue = 'project' | 'date';

export const mobileHomeChatViewModeAtom = atomWithStorage<MobileChatViewModeValue>(
  'lody-mobile-home-chat-view-mode',
  'project'
);

/* Each "excluded set" atom holds the option ids the user has explicitly
   opted OUT of. Empty array = "all options selected" (no filter). New
   machines / new enum values are therefore included by default, which
   matches the pill bar's `defaultIds = full set` semantics. */
export const mobileHomeChatExcludedRunningAtom = atomWithStorage<string[]>(
  'lody-mobile-home-chat-excluded-running',
  []
);
export const mobileHomeChatExcludedPrAtom = atomWithStorage<string[]>(
  'lody-mobile-home-chat-excluded-pr',
  []
);
export const mobileHomeChatExcludedMachinesAtom = atomWithStorage<string[]>(
  'lody-mobile-home-chat-excluded-machines',
  []
);
/* Excluded repo full-names (e.g. "owner/repo") and local-project
   keys (machineId:projectId). The pill on the home page replaces
   the old "type" filter with these two narrower dimensions —
   users almost always want "show this repo's tasks" rather than
   "show all GitHub tasks". */
export const mobileHomeChatExcludedReposAtom = atomWithStorage<string[]>(
  'lody-mobile-home-chat-excluded-repos',
  []
);
export const mobileHomeChatExcludedProjectsAtom = atomWithStorage<string[]>(
  'lody-mobile-home-chat-excluded-projects',
  []
);

/* Which sub-tab (Local vs GitHub) the user last visited inside the
   merged "项目" home tab. Persisted so flipping over to Chat and back
   restores the previous sub-tab, and so refreshing the page lands the
   user on whichever side they were last on. Mirrors the rationale for
   the chat-tab atoms above. */
export type MobileProjectsSubTabValue = 'local' | 'github';

export const mobileHomeProjectsSubTabAtom = atomWithStorage<MobileProjectsSubTabValue>(
  'lody-mobile-home-projects-sub-tab',
  'local'
);

/* One-shot handoff when a phone leaves the schedule editor (or opens the
   bare /schedules URL). The home screen reads it on mount and then clears
   it, so a later visit to Chat does not stay stuck on Schedules. Not
   persisted: this only has to survive the navigation that remounts home. */
export const mobileHomeReturnTabAtom = atom<'schedules' | null>(null);

/**
 * Thin adapter that exposes a `string[]`-backed atom as if it were a
 * `useState<Set<T>>` pair. Returns a stable `Set` (memoised on the
 * array reference) and a setter that accepts a `Set<T>` and writes
 * the underlying array.
 */
export function useMobileHomeExcludedSetAtom<T extends string>(
  storageAtom: PrimitiveAtom<string[]>
): [Set<T>, (next: Set<T>) => void] {
  const [stored, setStored] = useAtom(storageAtom);
  const asSet = useMemo(() => new Set(stored as T[]), [stored]);
  const setSet = useCallback(
    (next: Set<T>) => {
      setStored(Array.from(next));
    },
    [setStored]
  );
  return [asSet, setSet];
}

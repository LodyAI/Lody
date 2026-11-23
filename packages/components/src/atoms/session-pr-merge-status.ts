import { atom, type createStore } from 'jotai';
import { atomFamily } from 'jotai/utils';

type JotaiStore = ReturnType<typeof createStore>;

export type SessionPrMergePhase = 'merging' | 'merged' | 'failed';

export interface SessionPrMergeStatus {
  phase: SessionPrMergePhase;
  prNumber?: number;
  repoFullName?: string;
  error?: string;
}

export const OPTIMISTIC_PR_MERGED_TTL_MS = 15_000;

export const sessionPrMergeStatusesAtom = atom<Record<string, SessionPrMergeStatus>>({});

const optimisticMergedTimers = new WeakMap<
  JotaiStore,
  Map<string, ReturnType<typeof setTimeout>>
>();

function getStoreTimers(store: JotaiStore): Map<string, ReturnType<typeof setTimeout>> {
  let timers = optimisticMergedTimers.get(store);
  if (!timers) {
    timers = new Map();
    optimisticMergedTimers.set(store, timers);
  }
  return timers;
}

function clearOptimisticMergedTimer(store: JotaiStore, sessionId: string) {
  const timers = optimisticMergedTimers.get(store);
  const timer = timers?.get(sessionId);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers?.delete(sessionId);
  }
}

function sameStatus(a: SessionPrMergeStatus | null, b: SessionPrMergeStatus | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.phase === b.phase &&
    a.prNumber === b.prNumber &&
    a.repoFullName === b.repoFullName &&
    a.error === b.error
  );
}

export const sessionPrMergeStatusAtomFamily = atomFamily((sessionId: string) => {
  let previous: SessionPrMergeStatus | null = null;
  return atom((get) => {
    const next = get(sessionPrMergeStatusesAtom)[sessionId] ?? null;
    if (sameStatus(previous, next)) return previous;
    previous = next;
    return next;
  });
});

export function setSessionPrMerging(
  store: JotaiStore,
  sessionId: string,
  meta?: { prNumber?: number; repoFullName?: string }
) {
  clearOptimisticMergedTimer(store, sessionId);
  store.set(sessionPrMergeStatusesAtom, (prev) => ({
    ...prev,
    [sessionId]: {
      phase: 'merging',
      prNumber: meta?.prNumber,
      repoFullName: meta?.repoFullName,
    },
  }));
}

export function setSessionPrMergedOptimistic(
  store: JotaiStore,
  sessionId: string,
  meta?: { prNumber?: number; repoFullName?: string }
) {
  clearOptimisticMergedTimer(store, sessionId);
  const nextEntry: SessionPrMergeStatus = {
    phase: 'merged',
    prNumber: meta?.prNumber,
    repoFullName: meta?.repoFullName,
  };
  store.set(sessionPrMergeStatusesAtom, (prev) => ({
    ...prev,
    [sessionId]: nextEntry,
  }));
  const timer = setTimeout(() => {
    optimisticMergedTimers.get(store)?.delete(sessionId);
    store.set(sessionPrMergeStatusesAtom, (prev) => {
      const current = prev[sessionId];
      if (!current || current.phase !== 'merged') return prev;
      const { [sessionId]: _removed, ...rest } = prev;
      return rest;
    });
  }, OPTIMISTIC_PR_MERGED_TTL_MS);
  getStoreTimers(store).set(sessionId, timer);
}

export function setSessionPrMergeFailed(
  store: JotaiStore,
  sessionId: string,
  meta?: { prNumber?: number; repoFullName?: string; error?: string }
) {
  clearOptimisticMergedTimer(store, sessionId);
  store.set(sessionPrMergeStatusesAtom, (prev) => ({
    ...prev,
    [sessionId]: {
      phase: 'failed',
      prNumber: meta?.prNumber,
      repoFullName: meta?.repoFullName,
      error: meta?.error,
    },
  }));
}

export function clearSessionPrMergeStatus(
  store: JotaiStore,
  sessionId: string,
  onlyPhase?: SessionPrMergePhase
) {
  const current = store.get(sessionPrMergeStatusesAtom)[sessionId];
  if (!current) return;
  if (onlyPhase && current.phase !== onlyPhase) return;
  clearOptimisticMergedTimer(store, sessionId);
  store.set(sessionPrMergeStatusesAtom, (prev) => {
    const entry = prev[sessionId];
    if (!entry || (onlyPhase && entry.phase !== onlyPhase)) return prev;
    const { [sessionId]: _removed, ...rest } = prev;
    return rest;
  });
}

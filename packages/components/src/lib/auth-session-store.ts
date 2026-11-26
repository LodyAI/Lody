import type { LodyAuthClient } from './auth';

export type AuthSessionSnapshot = ReturnType<LodyAuthClient['useSession']>;

export type AuthSessionAtom = {
  get: () => AuthSessionSnapshot;
  listen: (listener: (value: AuthSessionSnapshot) => void) => () => void;
};

type AuthSessionEntry = {
  atom: AuthSessionAtom;
  snapshot: AuthSessionSnapshot;
  refs: number;
  unsubscribe: (() => void) | null;
  listeners: Set<() => void>;
};

export type AuthSessionStore = {
  getSnapshot: () => AuthSessionSnapshot;
  subscribe: (listener: () => void) => () => void;
  start: () => void;
  stop: () => void;
  refetch: AuthSessionSnapshot['refetch'];
};

const entries = new WeakMap<object, AuthSessionEntry>();

function readAuthSessionAtom(authClient: LodyAuthClient): AuthSessionAtom {
  const store = (authClient as { $store?: { atoms?: { session?: AuthSessionAtom } } }).$store;
  const atom = store?.atoms?.session;
  if (!atom || typeof atom.get !== 'function' || typeof atom.listen !== 'function') {
    throw new Error('Auth client is missing $store.atoms.session');
  }
  return atom;
}

function getEntry(authClient: LodyAuthClient): AuthSessionEntry {
  const key = authClient as object;
  const existing = entries.get(key);
  if (existing) return existing;

  const atom = readAuthSessionAtom(authClient);
  const entry: AuthSessionEntry = {
    atom,
    snapshot: atom.get(),
    refs: 0,
    unsubscribe: null,
    listeners: new Set(),
  };
  entries.set(key, entry);
  return entry;
}

function startEntry(entry: AuthSessionEntry): void {
  if (entry.refs++ > 0) return;

  entry.snapshot = entry.atom.get();
  entry.unsubscribe = entry.atom.listen((value) => {
    if (entry.snapshot === value) return;
    entry.snapshot = value;
    for (const listener of [...entry.listeners]) listener();
  });
}

function stopEntry(entry: AuthSessionEntry): void {
  if (entry.refs === 0 || --entry.refs > 0) return;
  entry.unsubscribe?.();
  entry.unsubscribe = null;
  entry.listeners.clear();
}

export function acquireAuthSessionStore(authClient: LodyAuthClient): AuthSessionStore {
  const entry = getEntry(authClient);
  let started = false;

  return {
    getSnapshot: () => entry.snapshot,
    subscribe(listener) {
      entry.listeners.add(listener);
      return () => entry.listeners.delete(listener);
    },
    start() {
      if (started) return;
      started = true;
      startEntry(entry);
    },
    stop() {
      if (!started) return;
      started = false;
      stopEntry(entry);
    },
    refetch(queryParams) {
      return entry.snapshot.refetch(queryParams);
    },
  };
}

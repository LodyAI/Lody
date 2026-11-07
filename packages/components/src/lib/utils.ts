import { clsx, type ClassValue } from 'clsx';
import type { Atom, PrimitiveAtom } from 'jotai';
import { createStore, useAtom, useAtomValue, useSetAtom } from 'jotai';
import { selectAtom } from 'jotai/utils';
import { useCallback } from 'react';
import { readStoredAuthToken } from './auth-bootstrap';

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

export const getToken = () => {
  return readStoredAuthToken();
};

export const getBasename = (filePath: string): string => {
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? filePath;
};

export const jotaiStore = createStore();

export const createAtomAccessor = <T>(atom: PrimitiveAtom<T>) =>
  [
    () => jotaiStore.get(atom),
    (value: T | ((prev: T) => T)) => jotaiStore.set(atom, value),
  ] as const;

const options = { store: jotaiStore };
/**
 * @param atom - jotai
 * @returns - [atom, useAtom, useAtomValue, useSetAtom, jotaiStore.get, jotaiStore.set, useSelector]
 */
export const createAtomHooks = <T>(atom: PrimitiveAtom<T>) => {
  let _atomSelector: ReturnType<typeof createAtomSelector<T>> | undefined;

  const result = [
    atom,
    () => useAtom(atom, options),
    () => useAtomValue(atom, options),
    () => useSetAtom(atom, options),
    ...createAtomAccessor(atom),
  ] as const;

  type Result = [...typeof result, ReturnType<typeof createAtomSelector<T>>];

  Object.defineProperty(result, result.length, {
    get() {
      if (!_atomSelector) {
        _atomSelector = createAtomSelector(atom);
      }
      return _atomSelector;
    },
  });

  return result as unknown as Result;
};

const createAtomSelector = <T>(atom: Atom<T>) => {
  const useHook = <R>(selector: (a: T) => R) =>
    useAtomValue(
      selectAtom(
        atom,
        useCallback((a) => selector(a as T), [selector]),
        shallow
      )
    );

  return useHook;
};

type EntriesProvider = {
  entries: () => Iterable<readonly [unknown, unknown]>;
};
type IterableWithEntries = Iterable<unknown> & EntriesProvider;

const isIterable = (obj: unknown): obj is Iterable<unknown> =>
  typeof obj === 'object' && obj !== null && Symbol.iterator in obj;
const hasIterableEntries = (value: Iterable<unknown>): value is IterableWithEntries =>
  typeof (value as { entries?: unknown }).entries === 'function';
const compareEntries = (valueA: EntriesProvider, valueB: EntriesProvider) => {
  const mapA = valueA instanceof Map ? valueA : new Map(valueA.entries());
  const mapB = valueB instanceof Map ? valueB : new Map(valueB.entries());
  if (mapA.size !== mapB.size) {
    return false;
  }
  for (const [key, value] of mapA) {
    if (!Object.is(value, mapB.get(key))) {
      return false;
    }
  }
  return true;
};
const compareIterables = (valueA: Iterable<unknown>, valueB: Iterable<unknown>) => {
  const iteratorA = valueA[Symbol.iterator]();
  const iteratorB = valueB[Symbol.iterator]();
  let nextA = iteratorA.next();
  let nextB = iteratorB.next();
  while (!nextA.done && !nextB.done) {
    if (!Object.is(nextA.value, nextB.value)) {
      return false;
    }
    nextA = iteratorA.next();
    nextB = iteratorB.next();
  }
  return !!nextA.done && !!nextB.done;
};
function shallow(valueA: unknown, valueB: unknown) {
  if (Object.is(valueA, valueB)) {
    return true;
  }
  if (
    typeof valueA !== 'object' ||
    valueA === null ||
    typeof valueB !== 'object' ||
    valueB === null
  ) {
    return false;
  }
  if (Object.getPrototypeOf(valueA) !== Object.getPrototypeOf(valueB)) {
    return false;
  }
  if (isIterable(valueA) && isIterable(valueB)) {
    if (hasIterableEntries(valueA) && hasIterableEntries(valueB)) {
      return compareEntries(valueA, valueB);
    }
    return compareIterables(valueA, valueB);
  }
  return compareEntries(
    { entries: () => Object.entries(valueA) },
    { entries: () => Object.entries(valueB) }
  );
}

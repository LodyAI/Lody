import { afterAll, afterEach, beforeEach, vi } from 'vitest';

// Tests own and unmount their React roots. Restore browser/process test doubles
// after those local teardown hooks, without resetting the reusable module graph.
const fileGlobals = Object.getOwnPropertyDescriptors(globalThis);
const fileWindow =
  typeof window === 'undefined' ? undefined : Object.getOwnPropertyDescriptors(window);
let globals: PropertyDescriptorMap;
let windowProperties: PropertyDescriptorMap | undefined;
beforeEach(() => {
  globals = Object.getOwnPropertyDescriptors(globalThis);
  windowProperties =
    typeof window === 'undefined' ? undefined : Object.getOwnPropertyDescriptors(window);
});

function restoreProperties(target: object, descriptors: PropertyDescriptorMap) {
  for (const key of Reflect.ownKeys(target)) {
    if (typeof key !== 'string' || key in descriptors) continue;
    if (Object.getOwnPropertyDescriptor(target, key)?.configurable)
      Reflect.deleteProperty(target, key);
  }
  for (const [key, descriptor] of Object.entries(descriptors)) {
    const current = Object.getOwnPropertyDescriptor(target, key);
    if (!current || current.configurable) {
      Object.defineProperty(target, key, descriptor);
    }
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.useRealTimers();
  if (windowProperties) restoreProperties(window, windowProperties);
  restoreProperties(globalThis, globals);
  globalThis.localStorage?.clear();
  globalThis.sessionStorage?.clear();
  if (typeof document !== 'undefined') {
    document.body.replaceChildren();
    document.documentElement.removeAttribute('class');
    document.documentElement.removeAttribute('style');
    window.history.replaceState(null, '', '/');
  }
});

afterAll(() => {
  if (fileWindow) restoreProperties(window, fileWindow);
  restoreProperties(globalThis, fileGlobals);
});

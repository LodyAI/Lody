import { useSyncExternalStore } from 'react';

const read = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
const subscribe = (listener: () => void) => {
  if (typeof document === 'undefined') return () => {};
  document.addEventListener('visibilitychange', listener);
  return () => document.removeEventListener('visibilitychange', listener);
};

/** Visibility is separate from mounting: retained tabs must release optional work. */
export function useDocumentVisible(): boolean {
  return useSyncExternalStore(subscribe, read, () => true);
}

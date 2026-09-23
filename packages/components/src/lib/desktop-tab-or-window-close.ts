import { useEffect, useRef } from 'react';

export type DesktopTabCloseResult = 'handled' | 'unhandled';
export type DesktopTabCloser = () => DesktopTabCloseResult;

const closers: DesktopTabCloser[] = [];

export function registerDesktopTabCloser(closer: DesktopTabCloser): () => void {
  closers.push(closer);
  return () => {
    const index = closers.lastIndexOf(closer);
    if (index !== -1) closers.splice(index, 1);
  };
}

export function closeCurrentTabOrWindow(): void {
  const closer = closers.at(-1);
  if (closer?.() === 'handled') return;
  window.close();
}

export function useDesktopTabCloser(closer: DesktopTabCloser, enabled = true): void {
  const closerRef = useRef(closer);
  closerRef.current = closer;

  useEffect(() => {
    if (!enabled) return undefined;
    return registerDesktopTabCloser(() => closerRef.current());
  }, [enabled]);
}

export function __resetDesktopTabClosersForTests(): void {
  closers.length = 0;
}

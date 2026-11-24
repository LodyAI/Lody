import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import {
  registerMobileBackHandler,
  type MobileBackHandler,
  type MobileBackLayer,
} from '@/lib/mobile-back-navigation';

const MobileBackDepthContext = createContext(0);

export function MobileBackDepthProvider({ children }: { children: ReactNode }) {
  const depth = useContext(MobileBackDepthContext);
  return (
    <MobileBackDepthContext.Provider value={depth + 1}>{children}</MobileBackDepthContext.Provider>
  );
}

export function useMobileBackHandler(
  handler: MobileBackHandler | null | undefined,
  options?: { enabled?: boolean; layer?: MobileBackLayer }
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  const depth = useContext(MobileBackDepthContext);
  const layer = options?.layer ?? 'page';
  const active = Boolean(handler) && (options?.enabled ?? true);

  useEffect(() => {
    if (!active) return undefined;
    return registerMobileBackHandler(() => (handlerRef.current ? handlerRef.current() : false), {
      layer,
      depth,
    });
  }, [active, layer, depth]);
}

import { createContext, useContext, useState, type ReactNode, type RefCallback } from 'react';
import { createPortal } from 'react-dom';
import * as stylex from '@stylexjs/stylex';
import { space } from '@lody/ui/tokens/scales.stylex';

const SlotContext = createContext<RefCallback<HTMLDivElement> | null>(null);

const styles = stylex.create({
  slot: { flexShrink: 0, minWidth: 0 },
  // Without a sidebar host (for example during startup), keep the entry reachable.
  floating: {
    position: 'fixed',
    left: `max(${space[4]}, env(safe-area-inset-left, 0px))`,
    bottom: `calc(${space[4]} + env(safe-area-inset-bottom, 0px) + 3.5rem)`,
    zIndex: 40,
    maxWidth: `calc(100vw - ${space[8]})`,
    pointerEvents: 'none',
  },
});

export function AuthRecoveryEntryProvider({
  children,
  notice,
}: {
  children: ReactNode;
  notice: ReactNode;
}) {
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  return (
    <SlotContext.Provider value={setSlot}>
      {children}
      {notice ? (
        slot ? (
          createPortal(notice, slot)
        ) : (
          <div {...stylex.props(styles.floating)}>{notice}</div>
        )
      ) : null}
    </SlotContext.Provider>
  );
}

/** Hosts the recovery icon beside the existing workspace control. */
export function AuthRecoveryEntrySlot() {
  const register = useContext(SlotContext);
  return register ? (
    <div ref={register} data-auth-recovery-entry {...stylex.props(styles.slot)} />
  ) : null;
}

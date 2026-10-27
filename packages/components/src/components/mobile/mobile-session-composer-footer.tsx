import { type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';

/* Shared helpers for the mobile model-picker chip label.

   This file used to also export the in-session `MobileSessionComposerFooter`
   (model / thinking / fast row). That component was replaced by the
   consolidated run-config control (`mobile-session-run-config.tsx` +
   `mobile-run-config-sheet.tsx`) and removed. The two helpers below survive
   because the new-chat composer (`chat-landing.tsx`) + its story still use
   them: the model picker is the only chip allowed to shrink/truncate, keeping
   its tail via the rtl trick so a long "provider/model" name loses the prefix
   rather than the model. */

/* The trigger is a primitive's `className`: it stays a Tailwind string so the
   caller's own utilities keep winning over the primitive's own look. */
export const mobileModelPickerTriggerClassName = 'h-8 min-w-0 px-2 py-1 text-sm';

const styles = stylex.create({
  label: {
    display: 'block',
    minWidth: 0,
    maxWidth: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    textAlign: 'left',
    direction: 'rtl',
  },
});

export function MobileModelPickerLabel({ children }: { children: ReactNode }) {
  return (
    <span {...stylex.props(styles.label)}>
      <span dir="ltr">{children}</span>
    </span>
  );
}

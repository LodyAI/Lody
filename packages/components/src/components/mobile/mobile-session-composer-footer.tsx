import { type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';

/* Shared helpers for the mobile model-picker chip label.

   This file used to also export the in-session `MobileSessionComposerFooter`
   (model / thinking / fast row). That component was replaced by the
   consolidated run-config control (`mobile-session-run-config.tsx` +
   `mobile-run-config-sheet.tsx`) and removed. The two helpers below survive
   because the new-chat composer story still uses
   them: the model picker is the only chip allowed to shrink/truncate, keeping
   its tail via the rtl trick so a long "provider/model" name loses the prefix
   rather than the model. */

const styles = stylex.create({
  trigger: {
    height: 'calc(var(--spacing) * 8)',
    minWidth: 0,
    paddingInline: 'calc(var(--spacing) * 2)',
    paddingBlock: 'calc(var(--spacing) * 1)',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
  },
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

export const mobileModelPickerTriggerStyle = styles.trigger;

export function MobileModelPickerLabel({ children }: { children: ReactNode }) {
  return (
    <span {...stylex.props(styles.label)}>
      <span dir="ltr">{children}</span>
    </span>
  );
}

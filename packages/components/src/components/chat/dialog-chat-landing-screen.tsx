import type { ReactNode, Ref } from 'react';
import * as stylex from '@stylexjs/stylex';
import { space } from '@lody/ui/tokens/scales.stylex';

const styles = stylex.create({
  /* The keyboard-nav root of the embedded landing. It is an inline-size
     container, like the page's composer column, so the composer's own
     narrow-width rules read the dialog's width. */
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
    minWidth: 0,
    containerType: 'inline-size',
  },
});

export type DialogChatLandingScreenProps = {
  composer: ReactNode;
  noMachineHint?: ReactNode;
  agentConfigHint?: ReactNode;
  /** Scope root for the landing's arrow-key option ring. */
  navRootRef?: Ref<HTMLDivElement>;
};

/**
 * The new-chat landing laid out for a dialog: the hints and the composer.
 * The page's greeting, ambient boards, window drag strip, page-level drop
 * overlay and focus scope belong to the route and stay out of it.
 */
export function DialogChatLandingScreen({
  composer,
  noMachineHint,
  agentConfigHint,
  navRootRef,
}: DialogChatLandingScreenProps) {
  return (
    <div ref={navRootRef} {...stylex.props(styles.root)}>
      {noMachineHint}
      {agentConfigHint}
      {composer}
    </div>
  );
}

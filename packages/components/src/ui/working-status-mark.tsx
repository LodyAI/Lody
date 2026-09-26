import { useEffect, useState } from 'react';

import { cn } from '@/lib/utils';

import { WorkingGrid } from './working-grid';
import { WorkingGridCollapse } from './working-grid-collapse';

export type WorkingStatusMarkProps = {
  /** The session's agent is running. */
  working: boolean;
  /** The session has messages the user has not read. */
  unread: boolean;
  /** Text colour class for the grid, transition and dot. */
  className?: string;
};

/**
 * A session's working / unread mark, with the hand-over between them:
 *
 * - working → the {@link WorkingGrid};
 * - working → unread → the {@link WorkingGridCollapse} plays once (the tiles
 *   spin and gather, the dot pops and bounces), then the unread dot;
 * - unread → the 8px unread dot;
 * - neither → nothing.
 *
 * The transition fires only when `unread` is already true in the render where
 * `working` turns false. The two arrive on different transports, so pass
 * `working` through {@link useWorkingHandOver} first; it holds the grid until the
 * unread write lands. The previous `working` value is state adjusted during
 * render, so the transition lands in the same commit that removes the grid; keep
 * this component mounted across both states for it to see the change.
 */
export function WorkingStatusMark({ working, unread, className }: WorkingStatusMarkProps) {
  const [wasWorking, setWasWorking] = useState(working);
  const [finishing, setFinishing] = useState(false);
  if (wasWorking !== working) {
    setWasWorking(working);
    setFinishing(wasWorking && !working && unread);
  }

  if (working) {
    return <WorkingGrid data-session-working-indicator="" className={className} />;
  }
  if (unread && finishing) {
    return (
      <WorkingGridCollapse
        data-session-done-transition=""
        className={className}
        onDone={() => setFinishing(false)}
      />
    );
  }
  if (unread) {
    return (
      <span
        data-session-unread-dot=""
        className={cn('h-2 w-2 rounded-full bg-current', className)}
      />
    );
  }
  return null;
}

/** How long a finished row keeps its grid while it waits for the unread write. */
export const WORKING_HAND_OVER_MS = 1_500;

/**
 * The `working` value to draw, holding the grid briefly after work stops so the
 * done transition can still play when `unread` lands after `working` clears.
 *
 * A turn's end reaches the renderer on two transports with no ordering between
 * them: presence (working) is ephemeral and applied at once, while the unread
 * bump is a doc-meta write that the projection flushes a task later
 * (`atoms/doc-meta.ts`). Presence therefore usually clears first; without the
 * hold the mark unmounts and the dot later appears without the transition.
 * When `unread` never comes (the user is reading the session) the hold simply
 * lapses after {@link WORKING_HAND_OVER_MS}. Call it where the row stays mounted.
 */
export function useWorkingHandOver(working: boolean, unread: boolean): boolean {
  const [wasWorking, setWasWorking] = useState(working);
  const [holding, setHolding] = useState(false);
  if (wasWorking !== working) {
    setWasWorking(working);
    setHolding(wasWorking && !working && !unread);
  } else if (holding && unread) {
    setHolding(false);
  }
  useEffect(() => {
    if (!holding) return undefined;
    const timer = setTimeout(() => setHolding(false), WORKING_HAND_OVER_MS);
    return () => clearTimeout(timer);
  }, [holding]);
  return working || holding;
}

import { useState } from 'react';

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
 * `working` turns false. That matches how a turn ends: the CLI records the new
 * message (unread, a durable doc-meta write) before it releases the session's
 * presence (working). If presence lapses first — a crash or an expiry — the dot
 * simply appears later without the transition. The previous `working` value is
 * state adjusted during render, so the transition lands in the same commit that
 * removes the grid; keep this component mounted across both states for it to see
 * the change.
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

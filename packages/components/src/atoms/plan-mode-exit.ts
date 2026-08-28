import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import type { SessionId } from '@lody/shared';

/**
 * Pending approvals raised when THIS tab's user approves leaving plan mode
 * from a permission card, so the session view can drop plan mode from its
 * composer selector.
 *
 * A counter rather than a flag: a session can plan, implement, and plan again,
 * and each approval must be observable and consumed exactly once. Two
 * permission surfaces raise it (the floating card and the inline one in the
 * transcript) and the composer that owns the mode selection state is far from
 * both, so an atom beats threading a callback through the virtualized message
 * list.
 *
 * Local to the tab on purpose — the run-config selection it drives is local
 * too. Do not replace this with a doc/history-derived signal: a teammate's
 * approval, or an old approval arriving as the session doc syncs, would then
 * unset plan mode for a user who had just chosen it.
 */
export const planModeExitApprovalCountAtomFamily = atomFamily((_sessionId: SessionId) => atom(0));

/** Acknowledge only the approvals a consumer observed, preserving newer ones. */
export function consumeObservedPlanModeExitApprovals(current: number, observed: number): number {
  return Math.max(0, current - observed);
}

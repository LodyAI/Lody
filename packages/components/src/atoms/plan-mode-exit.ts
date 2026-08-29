import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import type { SessionId } from '@lody/shared';

export type PlanModeExitApprovalState = {
  latestRevision: number;
  consumedRevision: number;
};

export const createPlanModeExitApprovalState = (): PlanModeExitApprovalState => ({
  latestRevision: 0,
  consumedRevision: 0,
});

/**
 * Pending approvals raised when THIS tab's user approves leaving plan mode
 * from a permission card, so the session view can keep the next-turn composer
 * selection out of Plan until that choice becomes durable.
 *
 * Monotonic revisions rather than a flag: a session can plan, implement, and
 * plan again, and each approval must be observable and consumed exactly once. Two
 * permission surfaces raise it (the floating card and the inline one in the
 * transcript) and the composer that owns the mode selection state is far from
 * both, so an atom beats threading a callback through the virtualized message
 * list. Keep an approval pending across composer remounts; consume it only
 * after a non-Plan user turn is accepted or the user explicitly re-arms Plan.
 *
 * Local to the tab on purpose — the run-config selection it drives is local
 * too. Do not replace this with a doc/history-derived signal: a teammate's
 * approval, or an old approval arriving as the session doc syncs, would then
 * unset plan mode for a user who had just chosen it.
 */
export const planModeExitApprovalStateAtomFamily = atomFamily((_sessionId: SessionId) =>
  atom(createPlanModeExitApprovalState())
);

export function raisePlanModeExitApproval(
  state: PlanModeExitApprovalState
): PlanModeExitApprovalState {
  return { ...state, latestRevision: state.latestRevision + 1 };
}

export function hasPendingPlanModeExitApproval(state: PlanModeExitApprovalState): boolean {
  return state.latestRevision > state.consumedRevision;
}

/** Acknowledge only revisions a consumer observed, preserving newer ones. */
export function consumePlanModeExitApprovalsThrough(
  state: PlanModeExitApprovalState,
  observedRevision: number
): PlanModeExitApprovalState {
  const consumedRevision = Math.min(
    state.latestRevision,
    Math.max(state.consumedRevision, observedRevision)
  );
  return consumedRevision === state.consumedRevision ? state : { ...state, consumedRevision };
}

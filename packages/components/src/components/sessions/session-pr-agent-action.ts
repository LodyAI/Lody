import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';

/**
 * The live "resolve merge conflicts" action for a session, published by the
 * mounted `session-chat-interface` (which owns the prompt dispatch) and consumed
 * by the PR tab (`pr-tab-container` → `pr-tab-view`), a separate render subtree.
 *
 * Both surfaces must stay in lockstep: clicking either one dispatches the SAME
 * agent prompt and flips `pending` for both, and the action goes away on both
 * once the agent picks it up. Routing it through one shared atom keeps that
 * coordination in a single place instead of duplicating dispatch/pending logic.
 */
export interface SessionResolveConflictsAction {
  /** Dispatch the resolve-conflicts prompt to this session. No-op while pending. */
  run: () => void;
  /** Dispatch in flight — both surfaces show loading and block re-clicks. */
  pending: boolean;
  /**
   * Whether the action is currently offerable: an open PR in conflict, the
   * agent idle, and GitHub actions permitted. Mirrors the info-bar action list,
   * so the PR-tab button and the info-bar button appear/disappear together.
   */
  available: boolean;
}

/**
 * Keyed by session id. `null` when no chat interface is publishing for that
 * session (e.g. the PR tab is open without its owning session mounted, or in
 * Storybook / the landing demo), in which case the PR tab shows its disabled
 * merge and leaves the conflict to the merge card.
 */
export const resolveConflictsActionAtomFamily = atomFamily((_sessionId: string) =>
  atom<SessionResolveConflictsAction | null>(null)
);

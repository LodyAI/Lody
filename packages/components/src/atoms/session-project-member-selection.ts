import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import type { ProjectMemberId, SessionId } from '@lody/shared';

/**
 * The repository Member a multi-repository conversation is describing in its
 * Info Bar and PR tab. The Repositories panel writes it; the context stage and
 * the PR tab read it. It is view state, like the Info Bar's staged item: not
 * persisted and reset with the app.
 *
 * Keyed by the workspace-owner Session, so a child tab and its root agree.
 */
export const sessionProjectMemberSelectionAtomFamily = atomFamily((_sessionId: SessionId) =>
  atom<ProjectMemberId | null>(null)
);

import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import type { SessionFilePayload, SessionId, SessionImagePayload } from '@lody/shared';
import type { SessionFileTransferPhase } from '@/lib/session-file-upload';

/**
 * In-memory chat-landing draft state that must outlive the landing route's
 * unmount. The prompt text already survives through
 * `chatLandingSessionStateAtomFamily`; attachments and the reserved draft
 * session id used to live in component state, so navigating to another tab and
 * back silently dropped them (#242).
 *
 * Deliberately NOT `atomWithStorage`: a preview `blob:` URL and an in-flight
 * upload's `AbortController` cannot be serialized. Surviving a route unmount is
 * the whole requirement — losing a draft attachment when the app restarts is
 * expected.
 */

export type PendingImage = {
  localId: string;
  previewUrl: string;
  file: File;
  status: 'uploading' | 'uploaded' | 'failed';
  progress: number;
  error?: string;
  uploaded?: SessionImagePayload;
};

export type PendingFile = {
  localId: string;
  file: File;
  status: SessionFileTransferPhase | 'uploaded' | 'failed';
  progress: number;
  error?: string;
  uploaded?: SessionFilePayload;
  abort?: AbortController;
};

/**
 * The one home for the landing draft's attachment scope. Attachments are
 * uploaded into a specific workspace — an `imageId`/`fileId` from one workspace
 * cannot be attached to a session in another — so unlike the prompt text (keyed
 * by user alone) the attachment draft is workspace-scoped.
 *
 * Keyed on the workspace SLUG rather than the resolved id: the slug is a route
 * param that is stable for the whole mount, while `useResolvedWorkspaceScope()`
 * reports `null` until the workspace resolves. A key that flips mid-mount would
 * strand whatever was added before it settled.
 *
 * `stateKey` is the prompt text's own key — the one passed to
 * `chatLandingSessionStateAtomFamily`, which an alternate landing surface may
 * suffix so it does not clobber the main draft. Pass that, not a raw user id, or
 * a suffixed surface would share this scope with the main landing.
 */
export const buildChatLandingDraftKey = (stateKey: string | null, workspaceSlug: string): string =>
  `${stateKey ?? 'anonymous'}:${workspaceSlug}`;

export const chatLandingPendingImagesAtomFamily = atomFamily((_draftKey: string) =>
  atom<PendingImage[]>([])
);

export const chatLandingPendingFilesAtomFamily = atomFamily((_draftKey: string) =>
  atom<PendingFile[]>([])
);

export const chatLandingDraftSessionIdAtomFamily = atomFamily((_draftKey: string) =>
  atom<SessionId | null>(null)
);

/**
 * The `resetDraftKey` this scope has already been cleared for. It lives beside
 * the draft rather than in a mount-scoped ref because the draft now outlives the
 * route: a `New chat` URL keeps its `resetDraftKey` in the history entry, so
 * navigating back to it would otherwise re-apply the same reset and destroy the
 * draft this module exists to preserve — revoking its preview URLs and aborting
 * its uploads on the way out.
 */
export const chatLandingAppliedResetKeyAtomFamily = atomFamily((_draftKey: string) =>
  atom<string | null>(null)
);

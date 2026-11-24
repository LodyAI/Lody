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
  status: 'draft' | 'uploading' | 'uploaded' | 'failed';
  progress: number;
  error?: string;
  uploaded?: SessionImagePayload;
  abort?: AbortController;
};

export type PendingFile = {
  localId: string;
  file: File;
  status: 'draft' | SessionFileTransferPhase | 'uploaded' | 'failed';
  progress: number;
  error?: string;
  uploaded?: SessionFilePayload;
  abort?: AbortController;
};

/**
 * The one home for a landing draft's complete scope. Attachments are
 * uploaded into a specific workspace — an `imageId`/`fileId` from one workspace
 * cannot be attached to a session in another — and prompt text must not appear
 * in another workspace either, so every part uses this workspace-scoped key.
 *
 * Keyed on the workspace SLUG rather than the resolved id: the slug is a route
 * param that is stable for the whole mount, while `useResolvedWorkspaceScope()`
 * reports `null` until the workspace resolves. A key that flips mid-mount would
 * strand whatever was added before it settled.
 *
 * `stateKey` identifies the user and landing surface. An alternate landing
 * surface may suffix it so it does not clobber the main draft. Pass that, not a
 * raw user id, or a suffixed surface would share this scope with the main landing.
 */
export const buildChatLandingDraftKey = (stateKey: string | null, workspaceSlug: string): string =>
  `${stateKey ?? 'anonymous'}:${workspaceSlug}`;

/** A landing embedded outside the new-chat page (Today's "Convert to task" dialog). */
export type ChatLandingSurface = 'today-convert';

/**
 * The draft key of an alternate landing surface. The owner is resolved the
 * same way as the page's (`userAtom.id`, else the encrypted account id), and
 * the surface rides on it after a `#`, which never appears in the page's
 * `<owner>:<slug>` shape — including the anonymous case, where passing
 * `null` straight to `buildChatLandingDraftKey` would collide with the page.
 */
export const buildChatLandingSurfaceDraftKey = (
  owner: string | null | undefined,
  surface: ChatLandingSurface,
  workspaceSlug: string
): string => buildChatLandingDraftKey(`${owner ?? 'anonymous'}#${surface}`, workspaceSlug);

export const chatLandingPendingImagesAtomFamily = atomFamily((_draftKey: string) =>
  atom<PendingImage[]>([])
);

export const chatLandingPendingFilesAtomFamily = atomFamily((_draftKey: string) =>
  atom<PendingFile[]>([])
);

export const chatLandingDraftSessionIdAtomFamily = atomFamily((_draftKey: string) =>
  atom<SessionId | null>(null)
);

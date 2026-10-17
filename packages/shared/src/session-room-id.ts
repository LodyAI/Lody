import type { SessionId } from './ids';

export const SESSION_DOC_PREFIX = 'session-';
// Removed comment documents share the prefix but never represent a Session.
export const LEGACY_SESSION_COMMENT_DOC_PREFIX = 'session-comment-';
export const getSessionRoomId = (id: SessionId) => `${SESSION_DOC_PREFIX}${id}`;
export const isSessionDocRoomId = (roomId: string) =>
  roomId.startsWith(SESSION_DOC_PREFIX) &&
  !roomId.startsWith(LEGACY_SESSION_COMMENT_DOC_PREFIX) &&
  roomId.length > SESSION_DOC_PREFIX.length;
export const getSessionIdFromRoomId = (roomId: string): SessionId | null =>
  isSessionDocRoomId(roomId) ? (roomId.slice(SESSION_DOC_PREFIX.length) as SessionId) : null;

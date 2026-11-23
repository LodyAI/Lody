import type { WorkspaceId } from './ids';
import { LODY_PROTOCOLS } from './session-link-schemes.mjs';

/**
 * Today outline page identity: one Loro document per member per day.
 * Behavior: specs/today-outline.md (Data ownership).
 *
 * The user id is always `encodeURIComponent`-encoded so local ids such as
 * `local:…` cannot add segments to the Stream id. The date is the fixed-length
 * suffix, so parsing never depends on characters inside the user id.
 */
export const TODAY_DOC_PREFIX = 'today-';
export const LORO_TODAY_STREAM_SEGMENT = 'td';

export type TodayDate = string & { readonly __todayDate: unique symbol };

const TODAY_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TODAY_DATE_LENGTH = 10;

/** A real calendar date in `YYYY-MM-DD` form, or null. */
export function parseTodayDate(value: string): TodayDate | null {
  const match = TODAY_DATE_PATTERN.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return value as TodayDate;
}

export const encodeTodayUserId = (userId: string): string => encodeURIComponent(userId);

export function getTodayDocIdPrefix(userId: string): string {
  return `${TODAY_DOC_PREFIX}${encodeTodayUserId(userId)}-`;
}

export function getTodayDocId(userId: string, date: TodayDate): string {
  if (!userId) throw new Error('Today page id requires a user id');
  return `${getTodayDocIdPrefix(userId)}${date}`;
}

export function parseTodayDocId(docId: string): { userId: string; date: TodayDate } | null {
  if (!docId.startsWith(TODAY_DOC_PREFIX)) return null;
  const rest = docId.slice(TODAY_DOC_PREFIX.length);
  if (rest.length < TODAY_DATE_LENGTH + 2) return null;
  const date = parseTodayDate(rest.slice(-TODAY_DATE_LENGTH));
  if (!date || rest.at(-TODAY_DATE_LENGTH - 1) !== '-') return null;
  const encodedUser = rest.slice(0, -TODAY_DATE_LENGTH - 1);
  let userId: string;
  try {
    userId = decodeURIComponent(encodedUser);
  } catch {
    return null;
  }
  // Exactly one docId per user: reject non-canonical encodings.
  if (!userId || encodeTodayUserId(userId) !== encodedUser) return null;
  return { userId, date };
}

/** Prefix scans also match longer user ids (`abc` vs `abc-def`); check exactly. */
export function isTodayDocOfUser(docId: string, userId: string): boolean {
  return parseTodayDocId(docId)?.userId === userId;
}

export function getLoroTodayStreamId(
  workspaceId: WorkspaceId,
  userId: string,
  date: TodayDate
): string {
  return `${workspaceId}:${LORO_TODAY_STREAM_SEGMENT}:${encodeTodayUserId(userId)}:${date}`;
}

/** `lody://today/<userId>/<date>?workspace=<id>`: a member's page for one day. */
export function buildTodayLink(workspaceId: string, userId: string, date: TodayDate): string {
  return `${LODY_PROTOCOLS.resource}://today/${encodeTodayUserId(userId)}/${date}?workspace=${encodeURIComponent(workspaceId)}`;
}

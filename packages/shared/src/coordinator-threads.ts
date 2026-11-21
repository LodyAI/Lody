import { z } from 'zod';
import type { SessionId } from './ids';

const coordinatorSessionIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .transform((value) => value as SessionId);

export const COORDINATOR_REPLY_PREVIEW_MAX_CHARS = 280;
export const COORDINATOR_ANCHOR_ID_MAX_CHARS = 320;
export const COORDINATOR_THREAD_ROOTS_MAX_CHARS = 4096;
export const COORDINATOR_LINKED_SESSIONS_MAX_COUNT = 16;

export const CoordinatorAnchorRefSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('user_turn'),
      turnId: z.string().trim().min(1).max(200),
    })
    .strict(),
  z
    .object({
      kind: z.literal('coordinator_bubble'),
      turnId: z.string().trim().min(1).max(200),
      bubbleId: z.string().trim().min(1).max(200),
    })
    .strict(),
]);

export type CoordinatorAnchorRef = z.infer<typeof CoordinatorAnchorRefSchema>;

export const CoordinatorReplyAuthorSchema = z.enum(['user', 'coordinator']);
export type CoordinatorReplyAuthor = z.infer<typeof CoordinatorReplyAuthorSchema>;

export const CoordinatorReplyRefSchema = z
  .object({
    target: CoordinatorAnchorRefSchema,
    threadRootId: z.string().trim().min(1).max(COORDINATOR_ANCHOR_ID_MAX_CHARS),
    author: CoordinatorReplyAuthorSchema,
    previewText: z.string().max(COORDINATOR_REPLY_PREVIEW_MAX_CHARS),
  })
  .strict();

export type CoordinatorReplyRef = z.infer<typeof CoordinatorReplyRefSchema>;

export const CoordinatorLinkedSessionIdsSchema = z
  .array(coordinatorSessionIdSchema)
  .max(COORDINATOR_LINKED_SESSIONS_MAX_COUNT);

export function formatCoordinatorAnchorId(anchor: CoordinatorAnchorRef): string {
  return anchor.kind === 'user_turn'
    ? `turn:${anchor.turnId}`
    : `bubble:${anchor.turnId}:${anchor.bubbleId}`;
}

export function parseCoordinatorAnchorId(raw: string | null | undefined): CoordinatorAnchorRef | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > COORDINATOR_ANCHOR_ID_MAX_CHARS) return undefined;
  if (trimmed.startsWith('turn:')) {
    const turnId = trimmed.slice('turn:'.length).trim();
    return turnId && !turnId.includes('\n') ? { kind: 'user_turn', turnId } : undefined;
  }
  if (trimmed.startsWith('bubble:')) {
    const rest = trimmed.slice('bubble:'.length);
    const sep = rest.indexOf(':');
    if (sep <= 0) return undefined;
    const turnId = rest.slice(0, sep).trim();
    const bubbleId = rest.slice(sep + 1).trim();
    if (!turnId || !bubbleId || turnId.includes('\n') || bubbleId.includes('\n')) return undefined;
    return { kind: 'coordinator_bubble', turnId, bubbleId };
  }
  return undefined;
}

/**
 * Collapses Markdown syntax and whitespace into a compact single-line excerpt
 * suitable for reply banners and quote headers without hydrating older pages.
 */
export function buildCoordinatorReplyPreview(
  raw: string,
  maxChars = COORDINATOR_REPLY_PREVIEW_MAX_CHARS
): string {
  const cleaned = raw
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~>#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(cleaned);
  if (chars.length <= maxChars) return cleaned;
  return `${chars.slice(0, Math.max(1, maxChars - 1)).join('').trimEnd()}…`;
}

export function createCoordinatorReplyRef(args: {
  target: CoordinatorAnchorRef;
  existingThreadRootId?: string | null;
  author: CoordinatorReplyAuthor;
  text: string;
}): CoordinatorReplyRef {
  const parsedExistingRoot = args.existingThreadRootId
    ? parseCoordinatorAnchorId(args.existingThreadRootId)
    : undefined;
  const threadRootId = parsedExistingRoot
    ? formatCoordinatorAnchorId(parsedExistingRoot)
    : formatCoordinatorAnchorId(args.target);
  return {
    target: args.target,
    threadRootId,
    author: args.author,
    previewText: buildCoordinatorReplyPreview(args.text),
  };
}

/**
 * `threadRoots` is stored on `SessionEntry` as a newline-separated primitive
 * string so `LoroMap.getShallowValue()` reads it in O(1) without allocating a
 * nested `LoroList` container per turn.
 */
export function parseThreadRootsScalar(value: unknown): string[] {
  if (typeof value !== 'string' || value.length === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of value.split('\n')) {
    const parsed = parseCoordinatorAnchorId(part);
    if (!parsed) continue;
    const canonical = formatCoordinatorAnchorId(parsed);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(canonical);
  }
  return out;
}

export function mergeThreadRootsScalar(
  existing: unknown,
  additions: readonly (string | null | undefined)[]
): string | undefined {
  const merged = parseThreadRootsScalar(existing);
  const seen = new Set(merged);
  for (const candidate of additions) {
    const parsed = parseCoordinatorAnchorId(candidate);
    if (!parsed) continue;
    const canonical = formatCoordinatorAnchorId(parsed);
    if (seen.has(canonical)) continue;
    const nextJoined = merged.length === 0 ? canonical : `${merged.join('\n')}\n${canonical}`;
    if (nextJoined.length > COORDINATOR_THREAD_ROOTS_MAX_CHARS) break;
    seen.add(canonical);
    merged.push(canonical);
  }
  return merged.length > 0 ? merged.join('\n') : undefined;
}

const SESSION_LINK_REGEX = /(?:lody:\/\/session\/|session:\/\/)([A-Za-z0-9_-]{1,128})/g;

export function extractLinkedSessionIdsFromText(text: string): SessionId[] {
  if (!text) return [];
  const found: SessionId[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(SESSION_LINK_REGEX)) {
    const rawId = match[1]?.trim();
    if (!rawId || seen.has(rawId)) continue;
    const parsed = coordinatorSessionIdSchema.safeParse(rawId);
    if (!parsed.success) continue;
    seen.add(parsed.data);
    found.push(parsed.data);
    if (found.length >= COORDINATOR_LINKED_SESSIONS_MAX_COUNT) break;
  }
  return found;
}

export function formatCoordinatorReplyContextBlock(args: {
  threadRootId: string;
  repliedAuthor: CoordinatorReplyAuthor;
  quotedText: string;
  relatedSessionLinks?: readonly string[];
}): string {
  const attrs = [
    `thread_id="${args.threadRootId.replace(/"/g, '')}"`,
    `replied_author="${args.repliedAuthor}"`,
    ...(args.relatedSessionLinks?.length
      ? [`related_sessions="${args.relatedSessionLinks.join(',')}"`]
      : []),
  ].join(' ');
  const body = Array.from(args.quotedText.trim()).slice(0, 2000).join('');
  const quotedLines = (body || '(attachment)')
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  return `<reply_context ${attrs}>\nQuoted message being replied to:\n${quotedLines}\n</reply_context>`;
}

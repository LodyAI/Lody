import type { MessageContent, SessionHistoryParsed } from '@lody/shared';
// The module file, not the barrel: the barrel also exports renderer-only code
// (the feature flag reads `import.meta.env`), and this module is on the import
// path of `@lody/history-import`'s benchmark, which compiles without Vite types.
import type { TurnIndexRow } from './conversation-view/types';
import { getSearchableMarkdownText } from './session-chat-search';

/**
 * The left-rail table of contents for a session conversation: one entry per
 * ROUND (a user turn plus everything the agent did in response), so a reader
 * can see where they are and jump between turns.
 *
 * Two hard constraints shape this module, both load-bearing:
 *
 *  1. **It derives from `items`, never from the DOM.** The conversation is a
 *     `virtua` virtual list that only mounts rows near the viewport, so an
 *     IntersectionObserver / element-registration design (shadcn's
 *     `MessageScroller` approach) would simply miss every off-screen round.
 *     Reader position instead comes from Virtua's index math — see
 *     {@link resolveActiveOutlineIndex} and its caller in `ai-gui/view.tsx`.
 *
 *  2. **It must stay cheap during streaming.** `items` gets a new identity on
 *     every streamed delta, so the outline is rebuilt at token rate. Per-message
 *     memoization ({@link digestByMessage}) keeps that to one WeakMap hit per
 *     message; see {@link SUMMARY_SOURCE_WINDOW} for why the markdown cleanup
 *     never runs over a whole assistant answer, and {@link reuseConversationOutline}
 *     / {@link reuseOutlineAnchors} for why the arrays keep their identity. The
 *     same lesson is already recorded in `hooks/use-incremental-search-blocks.ts`,
 *     where full-history text extraction per delta had to be made incremental
 *     and chunked.
 */

/**
 * Max rendered length of a round's title (the user's opening words).
 * Sized to fill the hover card's 3-line clamp rather than starve it.
 */
export const OUTLINE_TITLE_MAX_LENGTH = 72;
/**
 * Max rendered length of a round's preview (the agent's opening words).
 * Sized to fill the hover card's 6-line clamp rather than starve it.
 */
export const OUTLINE_PREVIEW_MAX_LENGTH = 240;

/**
 * How much RAW text is fed to the markdown cleanup before truncation.
 *
 * `getSearchableMarkdownText` runs eight regexes over its input. A streaming
 * turn's message object changes on every delta, so running it over the whole
 * answer would rescan tens of KB at token rate. We only ever render the first
 * {@link OUTLINE_PREVIEW_MAX_LENGTH} characters, so slicing FIRST makes the
 * cost constant and independent of answer length. The window is generous
 * enough that markdown syntax removed by the cleanup cannot starve the result.
 */
export const SUMMARY_SOURCE_WINDOW = 960;

/**
 * Buckets for the tick width. A round's visual weight tracks how much was said
 * in it, which is what makes the rail scannable rather than a uniform comb.
 */
export type ConversationOutlineWeight = 0 | 1 | 2 | 3;

/**
 * Calibrated against 1000 rounds sampled from 218 real local sessions, not
 * guessed. Those rounds run p25≈690, p50≈1530, p75≈3080 characters of prose, so
 * these cut the population into near-quarters (25/24/25/26).
 *
 * The first guess here was 400/2000/8000, which put 79% of rounds in the middle
 * two buckets and only 4% in the top one — the widest tick almost never
 * appeared, so the rail spent its whole range on three widths. Round numbers
 * near the measured quartiles are what make all four carry information.
 */
const WEIGHT_THRESHOLDS = { light: 700, medium: 1_500, heavy: 3_000 } as const;

export interface ConversationOutlineEntry {
  /** Stable across rebuilds: the id of the message the round starts at. */
  readonly key: string;
  /** Index into the `items` array the outline was built from. */
  readonly messageIndex: number;
  /** The user's opening words, or a role-derived fallback. */
  readonly title: string;
  /** The agent's opening words; empty while the round has produced no prose. */
  readonly preview: string;
  /** True when the round leads with an agent turn rather than a user turn. */
  readonly startsWithAgent: boolean;
  readonly weight: ConversationOutlineWeight;
}

/**
 * The subset of a chat stream item this module reads: a hydrated message, or
 * a placeholder carrying the turn's index row. `turnIndex` is the absolute
 * position; without it the list position is used (fully hydrated lists).
 */
export interface ConversationOutlineSource {
  readonly type: string;
  readonly message?: SessionHistoryParsed;
  readonly row?: TurnIndexRow;
  readonly turnIndex?: number;
}

const EMPTY_OUTLINE: readonly ConversationOutlineEntry[] = [];

/** Writable while a round is being filled in; handed out `readonly`. */
type MutableOutlineEntry = {
  -readonly [K in keyof ConversationOutlineEntry]: ConversationOutlineEntry[K];
};

/**
 * Truncate by CODE POINT, not by UTF-16 unit: slicing mid-surrogate splits an
 * emoji into replacement characters, and a CJK conversation reaches the limit
 * at a completely different character count than an ASCII one.
 */
const truncateToLength = (value: string, maxLength: number): string => {
  // UTF-16 length is an upper bound on the code-point count, so this exits
  // without materializing an array for the common short case.
  if (value.length <= maxLength) return value;
  const codePoints = Array.from(value);
  if (codePoints.length <= maxLength) return value;
  return `${codePoints.slice(0, maxLength).join('').trimEnd()}…`;
};

/** Collapse to one line so wrapping is left to the hover card's line clamps. */
const collapseWhitespace = (value: string): string => value.replace(/\s+/g, ' ').trim();

export const firstTextOf = (items: readonly MessageContent[]): string | null => {
  for (const item of items) {
    if (item.type !== 'text') continue;
    const raw = item.text;
    if (typeof raw !== 'string' || !raw.trim()) continue;
    return raw.slice(0, SUMMARY_SOURCE_WINDOW);
  }
  return null;
};

/**
 * Approximate how much was said in a round. Counts prose only — tool payloads
 * and terminal output would make every implementation turn max out, which
 * defeats the point of a weight signal.
 */
export const proseLengthOf = (message: Pick<SessionHistoryParsed, 'items'>): number => {
  let total = 0;
  for (const item of message.items) {
    if (item.type === 'text' || item.type === 'thought') {
      total += typeof item.text === 'string' ? item.text.length : 0;
    } else if (item.type === 'proposed_plan') {
      total += typeof item.markdown === 'string' ? item.markdown.length : 0;
    }
  }
  return total;
};

const weightForLength = (length: number): ConversationOutlineWeight => {
  if (length >= WEIGHT_THRESHOLDS.heavy) return 3;
  if (length >= WEIGHT_THRESHOLDS.medium) return 2;
  if (length >= WEIGHT_THRESHOLDS.light) return 1;
  return 0;
};

/** Everything a round's entry needs from one message, derived once. */
type MessageDigest = {
  /** Opening prose, markdown stripped and collapsed, cut to the title limit. */
  readonly title: string;
  /** The same prose cut to the longer preview limit. */
  readonly preview: string;
  readonly proseLength: number;
};

/**
 * Keyed by message OBJECT. `buildChatStreamItems` keeps settled turns
 * reference-stable, so a rebuild costs one WeakMap hit per message — which is
 * what makes rebuilding at token rate affordable.
 *
 * Only the streaming turn misses, and its miss is bounded: the summary reads at
 * most {@link SUMMARY_SOURCE_WINDOW} characters, and `proseLength` walks that
 * one message's items. There is deliberately no second id-keyed cache to catch
 * that miss — because the summary comes from a fixed-length PREFIX, recomputing
 * it from the replacement object yields the identical string, so the extra
 * cache would buy one bounded regex pass and cost a hand-rolled eviction
 * policy plus a cross-cache staleness invariant.
 */
const digestByMessage = new WeakMap<SessionHistoryParsed, MessageDigest>();

const digestFromSource = (source: string | null, proseLength: number): MessageDigest => {
  const summary = source === null ? '' : collapseWhitespace(getSearchableMarkdownText(source));
  return {
    title: truncateToLength(summary, OUTLINE_TITLE_MAX_LENGTH),
    preview: truncateToLength(summary, OUTLINE_PREVIEW_MAX_LENGTH),
    proseLength,
  };
};

const getMessageDigest = (message: SessionHistoryParsed): MessageDigest => {
  const cached = digestByMessage.get(message);
  if (cached) return cached;
  const digest = digestFromSource(firstTextOf(message.items), proseLengthOf(message));
  digestByMessage.set(message, digest);
  return digest;
};

/**
 * A non-hydrated turn's digest comes from its index row summary (the same
 * head text and prose length, read shallowly by the view). Keyed by the row
 * object: the view replaces the row when the summary arrives or changes.
 */
const digestByRow = new WeakMap<TurnIndexRow, MessageDigest>();
const EMPTY_DIGEST: MessageDigest = { title: '', preview: '', proseLength: 0 };

const getRowDigest = (row: TurnIndexRow): MessageDigest => {
  const summary = row.summary;
  if (!summary) return EMPTY_DIGEST;
  const cached = digestByRow.get(row);
  if (cached) return cached;
  const digest = digestFromSource(
    summary.headText.trim() ? summary.headText.slice(0, SUMMARY_SOURCE_WINDOW) : null,
    summary.textChars
  );
  digestByRow.set(row, digest);
  return digest;
};

/**
 * Group the chat stream into rounds.
 *
 * A round starts at a user message and runs until the next one. Messages before
 * the first user message form their own leading round — an agent-initiated
 * session (a scheduled run, a fork) has real content there and must not be
 * unreachable from the rail.
 */
export function buildConversationOutline(
  items: readonly ConversationOutlineSource[]
): readonly ConversationOutlineEntry[] {
  // Rounds are filled in place — `weight` needs every message in the round and
  // `preview` needs the first agent reply, both of which arrive after the entry
  // is created. Spreading a replacement object at each step would allocate
  // three entries per round on every streamed delta.
  const entries: MutableOutlineEntry[] = [];
  let openRound: MutableOutlineEntry | undefined;
  let openRoundProseLength = 0;
  let openRoundHasPreview = false;

  const closeRound = () => {
    if (openRound) openRound.weight = weightForLength(openRoundProseLength);
    openRound = undefined;
    openRoundProseLength = 0;
    openRoundHasPreview = false;
  };

  for (let position = 0; position < items.length; position += 1) {
    const item = items[position];
    if (!item) continue;
    let key: string;
    let role: string;
    let digest: MessageDigest;
    if (item.type === 'message' && item.message) {
      key = item.message.id;
      role = item.message.role;
      digest = getMessageDigest(item.message);
    } else if (item.type === 'placeholder' && item.row) {
      key = item.row.id;
      role = item.row.role;
      digest = getRowDigest(item.row);
    } else {
      continue;
    }
    const messageIndex = item.turnIndex ?? position;
    const isUser = role === 'user';

    if (isUser || openRound === undefined) {
      closeRound();
      openRound = {
        key,
        messageIndex,
        title: digest.title,
        preview: isUser ? '' : digest.preview,
        startsWithAgent: !isUser,
        weight: 0,
      };
      entries.push(openRound);
      openRoundHasPreview = !isUser;
      openRoundProseLength = digest.proseLength;
      continue;
    }

    openRoundProseLength += digest.proseLength;
    if (openRoundHasPreview || role !== 'assistant' || !digest.preview) continue;
    openRound.preview = digest.preview;
    openRoundHasPreview = true;
  }

  closeRound();
  return entries.length ? entries : EMPTY_OUTLINE;
}

/**
 * Reuse the previous array when nothing a reader can see has changed.
 *
 * `items` gets a new identity on every streamed delta, so without this the
 * outline memo would hand the rail a fresh array at token rate and re-render
 * every tick. Comparison is field-wise and shallow — entries are flat records.
 */
export function reuseConversationOutline(
  previous: readonly ConversationOutlineEntry[] | undefined,
  next: readonly ConversationOutlineEntry[]
): readonly ConversationOutlineEntry[] {
  if (!previous || previous.length !== next.length) return next;
  for (let index = 0; index < next.length; index += 1) {
    const a = previous[index];
    const b = next[index];
    if (!a || !b) return next;
    if (
      a.key !== b.key ||
      a.messageIndex !== b.messageIndex ||
      a.title !== b.title ||
      a.preview !== b.preview ||
      a.weight !== b.weight ||
      a.startsWithAgent !== b.startsWithAgent
    ) {
      return next;
    }
  }
  return previous;
}

/** The subset of a built virtual row this module reads. */
export interface ConversationOutlineRow {
  readonly messageIndex: number;
}

/** An outline entry paired with the virtual row its round starts at. */
export interface ConversationOutlineAnchor {
  readonly outlineIndex: number;
  readonly rowIndex: number;
}

/**
 * Pair each outline entry with the FIRST virtual row of its round — the row a
 * jump scrolls to, and the row reader position is measured against.
 *
 * Entries with no rendered row are DROPPED rather than represented as holes, so
 * every consumer works on a strictly ascending list. A round can genuinely have
 * no rows: `buildChatStreamItems` discards empty assistant entries.
 *
 * Both inputs are ascending by `messageIndex`, so this is a two-pointer merge:
 * no hash map, no per-row allocation. It runs on every streamed delta over the
 * WHOLE row list, which is exactly the shape of pass this module exists to
 * avoid paying for.
 */
export function buildOutlineAnchors(
  rows: readonly ConversationOutlineRow[],
  outline: readonly ConversationOutlineEntry[]
): readonly ConversationOutlineAnchor[] {
  const anchors: ConversationOutlineAnchor[] = [];
  let rowIndex = 0;
  for (let outlineIndex = 0; outlineIndex < outline.length; outlineIndex += 1) {
    const entry = outline[outlineIndex];
    if (!entry) continue;
    while (rowIndex < rows.length && (rows[rowIndex]?.messageIndex ?? -1) < entry.messageIndex) {
      rowIndex += 1;
    }
    if (rowIndex >= rows.length) break;
    if (rows[rowIndex]?.messageIndex !== entry.messageIndex) continue;
    anchors.push({ outlineIndex, rowIndex });
  }
  return anchors;
}

/**
 * Reuse the previous anchors when they still say the same thing.
 *
 * The row list is rebuilt on every streamed delta, so without this the anchors
 * array takes a new identity at token rate — and everything derived from it
 * (the reader-position callback, the jump handler, the effects that depend on
 * them) is re-created along with it. Anchors only really change when a round
 * gains or loses rows.
 */
export function reuseOutlineAnchors(
  previous: readonly ConversationOutlineAnchor[] | undefined,
  next: readonly ConversationOutlineAnchor[]
): readonly ConversationOutlineAnchor[] {
  if (!previous || previous.length !== next.length) return next;
  for (let index = 0; index < next.length; index += 1) {
    const a = previous[index];
    const b = next[index];
    if (!a || !b) return next;
    if (a.outlineIndex !== b.outlineIndex || a.rowIndex !== b.rowIndex) return next;
  }
  return previous;
}

/**
 * A round whose start sits within this many pixels BELOW the viewport top still
 * counts as the round the reader is in.
 *
 * Without it, "started above the top edge" is exact to the pixel, and a jump
 * that settles a hair short — or a fractional scroll offset on a HiDPI display —
 * reports the PREVIOUS round while its successor visibly owns the top edge.
 * Must stay larger than the jump's settle tolerance in `ai-gui/view.tsx`, or a
 * settled jump can still read as the round before the one that was clicked.
 */
export const OUTLINE_ANCHOR_TOLERANCE_PX = 4;

/**
 * Which round is the reader in?
 *
 * The answer is the LAST round that has STARTED above the given offset —
 * matching the semantics of shadcn `MessageScroller`'s `currentAnchorId`, which
 * "remains set even after that anchor scrolls above the viewport". Highlighting
 * only a round whose title happens to be on screen would leave the rail blank
 * through most of a long turn, which is exactly when position matters most.
 *
 * `getRowOffset` is injected rather than taking a precomputed offset array on
 * purpose: this runs per scroll event, and the binary search asks Virtua for
 * O(log n) offsets instead of all of them. It also keeps this function pure and
 * testable without a DOM or a virtualizer.
 *
 * `offset` must already be in Virtua's ITEM-offset space. The conversation
 * viewport has top padding, so its `scrollOffset` is not; the caller measures
 * that delta once. See `ai-gui/view.tsx`.
 *
 * `isAtEnd` overrides the rule at the bottom of the list, where "the last round
 * to start above the viewport top" stops being the round the reader is in: the
 * final rounds are usually shorter than the viewport, so the scroll clamps and
 * the top edge keeps belonging to an earlier round. Without this, clicking the
 * newest round highlights an older one, and a streaming conversation pinned to
 * the bottom never highlights the turn currently being written.
 */
export function resolveActiveOutlineIndex(
  anchors: readonly ConversationOutlineAnchor[],
  getRowOffset: (rowIndex: number) => number,
  offset: number,
  isAtEnd = false
): number {
  if (!anchors.length) return -1;
  if (isAtEnd) return anchors[anchors.length - 1]?.outlineIndex ?? -1;

  const startedBy = offset + OUTLINE_ANCHOR_TOLERANCE_PX;
  let low = 0;
  let high = anchors.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const anchor = anchors[mid];
    if (!anchor) break;
    if (getRowOffset(anchor.rowIndex) <= startedBy) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  // Above the first round's anchor the reader is still in the first round —
  // `leadingContent` (session provenance) scrolls above it — so clamp to it
  // rather than reporting "nowhere" and blanking the rail.
  return (anchors[found === -1 ? 0 : found] ?? anchors[0])?.outlineIndex ?? -1;
}

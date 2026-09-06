import * as React from 'react';
import { ClipboardList, MessagesSquare, UserRoundCog, Github, Globe, Link } from 'lucide-react';
import { isInlineReferenceKind } from '@lody/shared';

import { MonochromeFileIcon, MonochromeFolderIcon } from '@/components/icons/file-icons';
import type { Mention, MentionChip, MentionChipResolver } from '@/ui/mention/index';

/**
 * Chip styling for composer mention ranges.
 *
 * Product-side on purpose: the mention primitive knows how to *paint* a chip
 * without disturbing the caret, but never which kinds are chips or what they
 * look like.
 *
 * ## The one rule
 *
 * A mention may not change the advance width of the range it decorates. The
 * highlighter mirrors the textarea character for character; a decoration one
 * pixel wider than its raw text drags every following glyph out from under the
 * caret. So the classes below set colour and nothing else — no padding, no
 * border, no font change. That constraint is also why there is no background:
 * a fill would need padding to look like anything, and padding is the one thing
 * that cannot be spent here.
 *
 * ## Which mentions get an icon
 *
 * Only the ones where an icon says more than the trigger character already
 * does. An icon has to be painted over characters the range already contains
 * and may not hang past them, so it can never be wider than what it replaces —
 * which makes it a poor trade against a `#`, `$`, or `/` that already names the
 * type perfectly well. Those keep their sigil and take the colour instead.
 *
 * Four exceptions earn the space:
 *
 * - `@file` / `@dir`, where the glyph carries information the text does not:
 *   which kind of file it is. `@` is also the widest trigger, so it is the one
 *   with room worth spending.
 * - `@session`, whose committed text is a bare `@<title-slug>` — nothing in it
 *   says "session", so without a glyph it is indistinguishable from a path.
 * - `@agent_role`, a bare `@<mentionSlug>` for the same reason, and one whose
 *   consequence — creating a Session — is worth being able to see at a glance.
 * - Pasted text, which has no trigger at all and buys a gutter with real
 *   characters — a figure space (U+2007, digit-width and non-breaking) at each
 *   end of the `[Pasted N chars]` label. Widths match exactly because the
 *   spaces really are in the text, and the label still degrades to something
 *   readable if the range is ever lost.
 */

/** Pads the pasted-text label so its chip has an icon gutter and right padding. */
const CHIP_PAD = '\u2007';
export const wrapPastedTextChipLabel = (label: string) => `${CHIP_PAD}${label}${CHIP_PAD}`;

/**
 * Sized in `em` so it tracks the surrounding font size. In the composer the
 * slot clamps it further — it can never exceed the character it covers.
 */
export const MENTION_ICON_CLASS_NAME = 'size-[1.05em] shrink-0';

/**
 * Colour is the whole signal — a decorated range has no visible background — so
 * these are text colours and nothing else. Pulled slightly toward the
 * foreground rather than sitting on raw `--primary`, which reads as neon
 * against prose once a sentence carries three mentions.
 *
 * Exported because the transcript's chips are the same object after send and
 * must not re-derive the colour: two copies of one `color-mix` drift apart the
 * first time either is tuned.
 */
export const MENTION_CHIP_CLASS_NAME =
  'text-[color-mix(in_srgb,hsl(var(--primary))_82%,hsl(var(--foreground)))]';
export const MENTION_NEUTRAL_CHIP_CLASS_NAME = 'text-muted-foreground';

/**
 * The kinds a mention range can carry, including the kindless fallback a range
 * built outside a hydrator leaves behind. Membership only — an unknown kind
 * keeps the plain highlight rather than becoming a chip.
 */
const CHIP_KINDS: ReadonlySet<string> = new Set([
  'file',
  'dir',
  'skill',
  'session',
  'command',
  'agent_role',
  'issue',
  'pr',
  'mention',
  'pasted_text',
]);

/**
 * The glyph for a kind, or `null` where the text already names the type.
 *
 * One table for both chip surfaces, so a `@file` looks like the same thing
 * before and after it is sent. `#482` and `$review-diff` keep their sigils and
 * get nothing; a session's text is a bare slug and pasted text has no sigil at
 * all, so those two need a glyph to say what they are; files and directories
 * earn one for a different reason — the glyph carries which KIND of file it is,
 * which the path does not.
 */
export function getMentionKindIcon(
  kind: string,
  { path, className = MENTION_ICON_CLASS_NAME }: { path?: string; className?: string } = {}
): React.ReactNode {
  if (kind === 'url') return <Link className={className} />;
  if (kind === 'github_repo') return <Github className={className} />;
  if (kind === 'browser_page') return <Globe className={className} />;
  if (kind === 'dir') return <MonochromeFolderIcon folderPath={path ?? ''} className={className} />;
  if (kind === 'file') return <MonochromeFileIcon filePath={path ?? ''} className={className} />;
  if (kind === 'session') return <MessagesSquare className={className} />;
  // Same reason as a session: the committed text is a bare `@<slug>`, so
  // nothing in it says the token is a Role rather than a path.
  if (kind === 'agent_role') return <UserRoundCog className={className} />;
  if (kind === 'pasted_text') return <ClipboardList className={className} aria-hidden="true" />;
  return null;
}

/**
 * A draft saved before the gutter existed still holds a bare `[Pasted N chars]`,
 * so the slot count is read off the text rather than assumed. Without the
 * figure space there is only the bracket to paint over — cramped, but never
 * misaligned, and it heals as soon as the draft is re-created.
 */
const pastedTextChip = (text: string): MentionChip => {
  const padded = text.startsWith(CHIP_PAD);
  return {
    icon: getMentionKindIcon('pasted_text'),
    className: MENTION_NEUTRAL_CHIP_CLASS_NAME,
    // figure space + '['  ...  ']' + figure space
    iconSlots: padded ? 2 : 1,
    trailingSlots: padded ? 2 : 1,
  };
};

/**
 * The path a file/dir chip derives its glyph from. Prefers the range's recorded
 * value; falls back to the text with its trigger stripped, which is what a
 * hydrated range (reloaded draft) leaves us with.
 */
const getMentionPath = (mention: Mention, text: string): string =>
  (mention.value || text).replace(/^@/, '');

/**
 * The composer's chip resolver. Stable across renders so the highlighter's memo
 * still holds.
 *
 * It decides only slot geometry — which is the composer-specific half. Which
 * glyph and which colour come from the shared table above, so the transcript
 * cannot disagree with it.
 */
export const getComposerMentionChip: MentionChipResolver = (mention: Mention, text: string) => {
  const kind = mention.kind ?? 'mention';
  if (isInlineReferenceKind(kind))
    return {
      className: `${MENTION_CHIP_CLASS_NAME} underline decoration-dotted underline-offset-2`,
      iconSlots: 0,
    };
  if (kind === 'pasted_text') return pastedTextChip(text);
  if (!CHIP_KINDS.has(kind)) return null;

  const icon = getMentionKindIcon(kind, { path: getMentionPath(mention, text) });
  // No glyph means the range keeps its own sigil visible and is coloured,
  // nothing more — so it surrenders no character to an icon slot.
  return { icon: icon ?? undefined, className: MENTION_CHIP_CLASS_NAME, iconSlots: icon ? 1 : 0 };
};

/**
 * Swap a chip's glyph for an Agent Role's own emoji.
 *
 * Applied by the composer, not by the table above: a committed range carries
 * only the Role id, and resolving that to an emoji needs the live catalog the
 * composer already holds. The emoji is what the user picked the Role by, so the
 * committed `@Reviewer` should show it rather than the generic category glyph.
 *
 * The span is boxed to the icon slot and clipped, because the slot covers ONE
 * character of real text and an emoji glyph is wider than a latin one — an
 * unconstrained span would drag every following glyph out from under the caret.
 */
export const applyAgentRoleEmojiChip = (chip: MentionChip, emoji: string): MentionChip => ({
  ...chip,
  icon: (
    <span
      aria-hidden="true"
      className={`${MENTION_ICON_CLASS_NAME} inline-flex items-center justify-center overflow-hidden text-[0.95em] leading-none`}
    >
      {emoji}
    </span>
  ),
  iconSlots: 1,
});

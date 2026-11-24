import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import * as React from 'react';

import { ClipboardList, MessagesSquare, UserRoundCog, Quote } from 'lucide-react';

import { MonochromeFileIcon, MonochromeFolderIcon } from '@/components/icons/file-icons';
import type { Mention, MentionChip, MentionChipResolver } from '@/ui/mention/index';

/**
 * Product appearance for atomic Lexical mentions. Icons and labels participate
 * in normal layout; the canonical string's delimiters never buy visual space.
 * Saved pasted-text labels retain their figure-space/bracket format, so the
 * resolver removes that prefix/suffix from presentation only.
 */
const CHIP_PAD = '\u2007';
const quoteStyles = stylex.create({
  quote: {
    marginInline: 1,
    color: colors.accent,
  },
});
export const wrapPastedTextChipLabel = (label: string) => `${CHIP_PAD}${label}${CHIP_PAD}`;

/**
 * Sized in `em` so it tracks the surrounding font size in its own layout box.
 */
const styles = stylex.create({
  icon: { width: '1.05em', height: '1.05em', flexShrink: 0 },
  chip: { color: colors.accent },
  neutralChip: { color: colors.secondaryLabel },
  emoji: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    fontSize: '0.95em',
    lineHeight: 1,
  },
});

export const MENTION_ICON_CLASS_NAME = stylex.props(styles.icon).className;

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
export const MENTION_CHIP_CLASS_NAME = stylex.props(styles.chip).className;
export const MENTION_NEUTRAL_CHIP_CLASS_NAME = stylex.props(styles.neutralChip).className;

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
  'prompt_shortcut',
  'agent_role',
  'issue',
  'pr',
  'mention',
  'pasted_text',
  'message_quote',
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
  if (kind === 'dir') return <MonochromeFolderIcon folderPath={path ?? ''} className={className} />;
  if (kind === 'file') return <MonochromeFileIcon filePath={path ?? ''} className={className} />;
  if (kind === 'session') return <MessagesSquare className={className} />;
  // Same reason as a session: the committed text is a bare `@<slug>`, so
  // nothing in it says the token is a Role rather than a path.
  if (kind === 'agent_role') return <UserRoundCog className={className} />;
  if (kind === 'pasted_text') return <ClipboardList className={className} aria-hidden="true" />;
  if (kind === 'message_quote') return <Quote className={className} aria-hidden="true" />;
  return null;
}

/**
 * Older drafts have bare brackets; newer ones also carry figure-space gutters.
 * Both formats keep their canonical text, with delimiters omitted from the view.
 */
const pastedTextChip = (text: string): MentionChip => {
  const padded = text.startsWith(CHIP_PAD);
  return {
    icon: getMentionKindIcon('pasted_text'),
    className: MENTION_NEUTRAL_CHIP_CLASS_NAME,
    // figure space + '['  ...  ']' + figure space
    textPrefixLength: padded ? 2 : 1,
    textSuffixLength: padded ? 2 : 1,
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
 * The composer's chip resolver. Module-level, so it stays stable across renders
 * and chip views do not re-render for nothing.
 *
 * It decides the visible label and icon — the composer-specific half. Which
 * glyph and which colour come from the shared table above, so the transcript
 * cannot disagree with it.
 */
export const getComposerMentionChip: MentionChipResolver = (mention: Mention, text: string) => {
  const kind = mention.kind ?? 'mention';
  if (kind === 'pasted_text') return pastedTextChip(text);
  if (kind === 'message_quote')
    return {
      ...pastedTextChip(text),
      icon: getMentionKindIcon(kind),
      className: stylex.props(quoteStyles.quote).className,
    };
  if (!CHIP_KINDS.has(kind)) return null;

  const icon = getMentionKindIcon(kind, { path: getMentionPath(mention, text) });
  // No glyph means the range keeps its own sigil visible and is coloured,
  // nothing more, without removing any prefix.
  return {
    icon: icon ?? undefined,
    className: MENTION_CHIP_CLASS_NAME,
    textPrefixLength: icon ? 1 : 0,
  };
};

/**
 * Swap a chip's glyph for an Agent Role's own emoji.
 *
 * Applied by the composer, not by the table above: a committed range carries
 * only the Role id, and resolving that to an emoji needs the live catalog the
 * composer already holds. The emoji is what the user picked the Role by, so the
 * committed `@Reviewer` should show it rather than the generic category glyph.
 *
 * The emoji gets the same layout box as other icons and does not alter the
 * canonical mention text or its string offsets.
 */
export const applyAgentRoleEmojiChip = (chip: MentionChip, emoji: string): MentionChip => ({
  ...chip,
  icon: (
    <span aria-hidden="true" {...stylex.props(styles.icon, styles.emoji)}>
      {emoji}
    </span>
  ),
  textPrefixLength: 1,
});

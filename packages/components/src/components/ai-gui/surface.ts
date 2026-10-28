import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { conversation } from './conversation.tokens.stylex';

export const conversationSurface = stylex.create({
  message: { paddingBlock: conversation.messagePadding },
  userMessage: { paddingTop: 0, paddingBottom: conversation.responseGap },
  firstRow: { paddingTop: 0 },
  proseRow: { paddingTop: conversation.proseGap, paddingBottom: 0 },
  surfaceRow: { paddingTop: conversation.surfaceGap, paddingBottom: 0 },
  processRow: { paddingBlock: 0 },
  footerRow: { paddingBlock: 0 },
  /* A system row carrying an Operation's bordered cards keeps the message pad
     above — the previous row's own bottom pad already composes to the surface
     gap there — and reserves the full surface gap below, so the next turn's
     first row (which adds no top pad) does not crowd the card. */
  operationSurface: {
    paddingTop: conversation.messagePadding,
    paddingBottom: conversation.surfaceGap,
  },
  lastRow: { paddingBottom: conversation.messagePadding },
  // Next-user metadata and footer actions share the round reserve. Taller
  // file cards or wrapped actions grow naturally beyond this minimum.
  roundFooter: {
    minHeight: `max(0px, calc(${conversation.roundGap} - ${conversation.metadataPitch} - ${conversation.metadataGap}))`,
  },
  roundFooterRow: { paddingBottom: 0 },
  // Mobile leads the action bar with "Worked for …": put it on the prose rail.
  mobileTurnActions: { paddingInlineStart: conversation.railInset },
  roundLastRow: {
    paddingBottom: `max(0px, calc(${conversation.roundGap} - ${conversation.metadataPitch} - ${conversation.metadataGap}))`,
  },
  processText: {
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
    fontWeight: 400,
    color: colors.secondaryLabel,
  },
  processLine: {
    display: 'flex',
    width: '100%',
    minHeight: conversation.activityPitch,
    alignItems: 'center',
    columnGap: space[1.5],
    paddingBlock: conversation.activityPadding,
    paddingInline: conversation.railInset,
    color: colors.secondaryLabel,
  },
  step: {
    width: 'fit-content',
    maxWidth: '100%',
    alignItems: 'flex-start',
    minHeight: conversation.activityPitch,
    paddingBlock: conversation.activityPadding,
    paddingInline: conversation.railInset,
    borderRadius: radius.mini,
    userSelect: 'none',
  },
  collapsible: {
    display: 'flex',
    width: '100%',
    alignItems: 'center',
    columnGap: space[1.5],
    borderRadius: radius.mini,
    paddingInline: space[1],
    paddingBlock: space[1],
    textAlign: 'start',
    color: { default: colors.secondaryLabel, ':hover': colors.label },
  },
  flushCollapsible: { paddingInline: 0 },
  disclosure: {
    display: 'flex',
    width: '100%',
    minHeight: conversation.activityPitch,
    alignItems: 'center',
    columnGap: `calc(${space[1]} / 2)`,
    paddingBlock: conversation.activityPadding,
    paddingInline: conversation.railInset,
    color: colors.secondaryLabel,
    textAlign: 'start',
  },
  mobileDisclosure: {
    columnGap: space[1.5],
    borderRadius: radius.mini,
    backgroundColor: { default: 'transparent', ':hover': conversation.activityHoverFill },
  },
  processStep: {
    display: 'flex',
    width: '100%',
    minHeight: conversation.activityPitch,
    alignItems: 'flex-start',
    columnGap: space[1.5],
    paddingBlock: conversation.activityPadding,
    paddingInline: conversation.railInset,
  },
  thoughtStep: { paddingInline: 0 },
  userRow: { display: 'flex', width: '100%', flexDirection: 'row-reverse', columnGap: space[2] },
  mobileUserRow: { paddingLeft: '28px' },
  author: {
    flexShrink: 0,
    color: colors.secondaryLabel,
    paddingTop: `calc(${conversation.metadataPitch} + ${conversation.metadataGap} + ${conversation.bubblePaddingBlock} + (${conversation.readingLeading} - ${space[8]}) / 2)`,
  },
  userStack: {
    position: 'relative',
    display: 'flex',
    minWidth: 0,
    flex: 1,
    flexDirection: 'column',
    alignItems: 'flex-end',
    rowGap: conversation.metadataGap,
    textAlign: 'start',
    maxWidth: {
      default: '100%',
      '@container (min-width: 520px)': '80%',
      '@container (min-width: 720px)': '70%',
    },
  },
  mobileUserStack: { maxWidth: 'min(100%, 28rem)' },
  metadata: {
    display: 'flex',
    minHeight: conversation.metadataPitch,
    flexDirection: 'row-reverse',
    alignItems: 'center',
    columnGap: space[1.5],
    color: colors.secondaryLabel,
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
  },
  userActions: {
    position: 'absolute',
    top: '100%',
    right: 0,
    marginTop: conversation.metadataGap,
    display: 'flex',
    columnGap: `calc(${space[1]} / 2)`,
  },
  attachments: {
    display: 'flex',
    minWidth: 0,
    maxWidth: '100%',
    flexDirection: 'column',
    alignItems: 'flex-end',
    rowGap: space[2],
  },
  bubbleRow: { display: 'flex', maxWidth: '100%', justifyContent: 'flex-end' },
  bubble: {
    minWidth: 0,
    maxWidth: '100%',
    borderRadius: conversation.bubbleRadius,
    backgroundColor: conversation.bubbleFill,
    paddingInline: conversation.bubblePaddingInline,
    paddingBlock: conversation.bubblePaddingBlock,
  },
  userText: {
    minWidth: 0,
    maxWidth: '100%',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    color: conversation.reading,
  },
  collapsed: { overflow: 'hidden' },
  expand: {
    marginTop: space[1],
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
});

/**
 * The Evidence tier of a turn: what the agent changed or produced, and the card
 * that holds it ([hierarchy Spec](../../../../../specs/workspace-visual-hierarchy.md)).
 * A name is the subheadline role at 500 in `label` ink, one step under the reading
 * prose above it, which sits at body size. Everything about the name — a directory,
 * a subtitle, a count — is quieter in ink, never in a fractional opacity. A hue
 * belongs only to an outcome (the diff counts), and the caller supplies it.
 *
 * A style sets what its tier fixes. An element takes one of these, except `detail`,
 * which nests inside a `name` and sets only weight and ink.
 */
export const evidenceSurface = stylex.create({
  name: {
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
    fontWeight: 500,
    color: colors.label,
  },
  detail: { fontWeight: 400, color: colors.tertiaryLabel },
  subtitle: {
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    fontWeight: 400,
    color: colors.secondaryLabel,
  },
  failed: { color: colors.destructive },
  caption: {
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    fontWeight: 500,
    color: colors.secondaryLabel,
  },
  action: {
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    fontWeight: 500,
    color: colors.secondaryLabel,
  },
  figure: { fontSize: text.footnoteSize, lineHeight: text.footnoteLeading },
  figureUnknown: { color: colors.tertiaryLabel },
});

import * as React from 'react';
import * as stylex from '@stylexjs/stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import { useTranslation } from 'react-i18next';

import { sanitizeMessageTextSpans, type MessageTextSpan } from '@lody/shared';
import { cn } from '@/lib/utils';
import {
  getMentionKindIcon,
  MENTION_CHIP_CLASS_NAME,
  MENTION_ICON_CLASS_NAME,
  MENTION_NEUTRAL_CHIP_CLASS_NAME,
} from '@/components/mentions/mention-chips';

/**
 * Mention chips inside a sent message.
 *
 * The composer's chips are painted over a live textarea and may not change the
 * advance width of a single character. These are not: a transcript bubble is
 * static text, so a chip here is ordinary inline text with a real glyph gutter,
 * free to wrap across lines like the prose it sits in. Only the layout is local
 * — the glyph and the colour come from `mention-chips.tsx`, which is what makes
 * `@src/a.ts` look like the same object before and after it is sent.
 *
 * The text these span is the *rewritten* text the agent received. A skill
 * mention is sitting in there as `use /x [Skill Path](...)`, a pasted blob as
 * its full four thousand characters. The chip covers that region and shows the
 * span's `label` — what the user actually typed — instead.
 */

/**
 * No background here either, matching the composer: a mention is coloured text
 * with an icon. Horizontal padding goes with it — without a fill there is
 * nothing to pad, so the glyph carries its own gutter (`mr-1`) instead.
 *
 * The chip is ordinary INLINE content, not an `inline-flex` box. An inline-flex
 * box is atomic: it can never break, so
 * `@packages/components/scripts/generate-chat-workspace-geometry-report.mjs`
 * had to fit on one line — it stretched the bubble out to its width cap and
 * then, once even that was not enough, ate its own tail under `truncate`,
 * hiding the file NAME, which is the most informative part of a path. As inline
 * content the label wraps exactly like the prose around it: the bubble stays as
 * wide as the message needs and the whole path stays readable.
 *
 * `[overflow-wrap:anywhere]` is what makes it break. It is the bubble's rule
 * too, restated here rather than inherited, because it is the reason this chip
 * may be inline at all: normal wrapping finds no opportunity inside a path, so
 * without it an inline chip would overflow the bubble rather than wrap.
 * `anywhere` still prefers the ordinary break points (after a `/` or a `-`), so
 * a path breaks on a segment boundary whenever one fits.
 */

/**
 * The label supplies the button's baseline, matching the surrounding prose.
 * The icon opts out of baseline participation and stays vertically centered.
 * Keep the short line-height so collapsed messages retain their line boxes.
 */
const styles = stylex.create({
  chip: { overflowWrap: 'anywhere' },
  inlineIcon: {
    marginRight: 'calc(var(--spacing) * 1)',
    display: 'inline-block',
    verticalAlign: 'middle',
  },
  mark: { fontSize: '1.05em', lineHeight: 1 },
  toggle: { cursor: 'pointer', textDecorationLine: { default: null, ':hover': 'underline' } },
  label: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  head: { whiteSpace: 'nowrap' },
  pasteButton: {
    display: 'inline-flex',
    maxWidth: '100%',
    alignItems: 'baseline',
    verticalAlign: 'baseline',
    gap: space[1],
    lineHeight: 1.15,
  },
  pasteIcon: {
    display: 'inline-flex',
    alignSelf: 'center',
  },
});

/**
 * Inline content has no flex `gap` to separate the glyph from the label and no
 * `items-center` to align it, so the glyph brings both itself. `inline-block`
 * is not cosmetic: the file/folder glyphs are empty `<span>`s painting a mask,
 * and width/height do not apply to a non-replaced inline box — left inline they
 * collapse to nothing.
 */

/** Keep the icon's unbreakable prefix on Unicode grapheme boundaries. */
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * How much of the label is tied to the glyph.
 *
 * An inline-block is an atomic inline, and every engine offers a line break
 * beside one whatever the surrounding text says — a WORD JOINER between them
 * does not hold. So a label too long for the rest of the line broke at that
 * boundary and left the glyph stranded at the end of the previous line, where
 * it reads as belonging to the words before it rather than to the path below.
 *
 * Binding the glyph to the first few characters with `white-space: nowrap`
 * moves that break: the group either fits, and the label goes on breaking
 * wherever it needs to, or it does not, and the whole chip starts the next line
 * intact. Four characters is enough to look like the beginning of a mention and
 * short enough that it cannot be what stops the bubble from getting narrow.
 */
const CHIP_UNBREAKABLE_HEAD_CHARS = 4;

function MessageTextChip({
  span,
  label,
  onToggle,
}: {
  span: MessageTextSpan;
  /** Resolved by the parent so a chip costs no i18n subscription of its own. */
  label: string;
  /** Only pasted text has an action: it expands in place. */
  onToggle?: () => void;
}) {
  const isBoxed = Boolean(onToggle);
  const className = cn(
    stylex.props(!isBoxed && styles.chip, onToggle && styles.toggle).className,
    span.kind === 'pasted_text' ? MENTION_NEUTRAL_CHIP_CLASS_NAME : MENTION_CHIP_CLASS_NAME
  );
  // A frozen mark (an Agent Role's emoji) stands in for the kind's icon, so the
  // bubble shows the same thing the composer did.
  const icon = span.mark ? (
    <span
      aria-hidden="true"
      className={stylex.props(styles.mark, !isBoxed && styles.inlineIcon).className}
    >
      {span.mark}
    </span>
  ) : (
    getMentionKindIcon(span.kind, {
      path: span.target,
      className: cn(MENTION_ICON_CLASS_NAME, stylex.props(!isBoxed && styles.inlineIcon).className),
    })
  );
  // Split by grapheme rather than code point so a surrogate pair, combining
  // mark, variation selector, or ZWJ sequence cannot be cut in half.
  const labelChars = Array.from(GRAPHEME_SEGMENTER.segment(label), ({ segment }) => segment);
  const head = labelChars.slice(0, CHIP_UNBREAKABLE_HEAD_CHARS).join('');
  const tail = labelChars.slice(CHIP_UNBREAKABLE_HEAD_CHARS).join('');
  // Truncation belongs to the boxed form alone: a wrapping label has nowhere to
  // overflow to, and clipping it would put back the lost tail this chip exists
  // to keep.
  const content = isBoxed ? (
    <>
      <span {...stylex.props(styles.pasteIcon)}>{icon}</span>
      <span {...stylex.props(styles.label)}>{label}</span>
    </>
  ) : (
    <>
      <span {...stylex.props(styles.head)}>
        {icon}
        {head}
      </span>
      {tail}
    </>
  );

  return onToggle ? (
    <button
      type="button"
      className={cn(stylex.props(styles.pasteButton).className, className)}
      onClick={onToggle}
    >
      {content}
    </button>
  ) : (
    <span className={className}>{content}</span>
  );
}

/**
 * Splits `text` on its spans and renders each span as a chip.
 *
 * Spans are re-sanitized against the exact string being rendered rather than
 * trusted from the caller, because that string may be a truncated slice — a
 * chip straddling the cut has nothing coherent to render and is dropped until
 * the bubble is expanded.
 */
export function MessageTextWithChips({
  text,
  spans,
}: {
  text: string;
  spans: readonly MessageTextSpan[] | undefined;
}) {
  const { t } = useTranslation();
  const resolved = React.useMemo(() => sanitizeMessageTextSpans(text, spans), [spans, text]);
  const [expanded, setExpanded] = React.useState<ReadonlySet<number>>(() => new Set());

  if (!resolved) return <>{text}</>;

  const nodes: React.ReactNode[] = [];
  let copiedTo = 0;

  for (const span of resolved) {
    if (span.start > copiedTo) {
      nodes.push(
        <React.Fragment key={`t-${copiedTo}`}>{text.slice(copiedTo, span.start)}</React.Fragment>
      );
    }

    const isExpanded = span.kind === 'pasted_text' && expanded.has(span.start);
    const start = span.start;
    nodes.push(
      <React.Fragment key={`s-${start}`}>
        <MessageTextChip
          span={span}
          label={
            isExpanded
              ? t('sessions.messageChip.collapsePastedText', 'Collapse pasted text')
              : span.label
          }
          onToggle={
            span.kind === 'pasted_text'
              ? () =>
                  setExpanded((prev) => {
                    const next = new Set(prev);
                    if (next.has(start)) next.delete(start);
                    else next.add(start);
                    return next;
                  })
              : undefined
          }
        />
        {isExpanded ? text.slice(span.start, span.end) : null}
      </React.Fragment>
    );

    copiedTo = span.end;
  }

  if (copiedTo < text.length) {
    nodes.push(<React.Fragment key="t-end">{text.slice(copiedTo)}</React.Fragment>);
  }

  return <>{nodes}</>;
}

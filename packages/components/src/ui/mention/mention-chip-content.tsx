import * as stylex from '@stylexjs/stylex';
import { radius } from '@lody/ui/tokens/scales.stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { cn } from '@/lib/utils';
import type { Mention, MentionChip } from './mention-root';

const styles = stylex.create({
  chip: {
    display: 'inline-flex',
    alignItems: 'baseline',
    gap: '0.2em',
    maxWidth: '100%',
    verticalAlign: 'baseline',
    borderRadius: radius.mini,
  },
  icon: {
    display: 'inline-flex',
    flexShrink: 0,
    width: '1em',
    height: '1em',
    transform: 'translateY(0.12em)',
  },
  label: { minWidth: 0, whiteSpace: 'normal', overflowWrap: 'anywhere' },
  fallback: { backgroundColor: `color-mix(in srgb, ${colors.accent} 15%, transparent)` },
  pastedFallback: { backgroundColor: `color-mix(in srgb, ${colors.label} 10%, transparent)` },
  selected: {
    backgroundColor: 'Highlight',
    borderRadius: 0,
  },
});

/** Only the visible label belongs in layout; wire-format delimiters take no space. */
function MentionChipContent({ chip, text }: { chip: MentionChip; text: string }) {
  const prefix = Math.max(0, Math.min(chip.textPrefixLength ?? 1, text.length));
  const suffix = Math.max(0, Math.min(chip.textSuffixLength ?? 0, text.length - prefix));
  return (
    <>
      {chip.icon ? (
        <span aria-hidden="true" {...stylex.props(styles.icon)}>
          {chip.icon}
        </span>
      ) : null}
      <span data-mention-label="" {...stylex.props(styles.label)}>
        {text.slice(prefix, text.length - suffix)}
      </span>
    </>
  );
}

/** The editor owns text/ranges; this view owns the atomic chip's presentation. */
export function MentionRangeView({
  mention,
  text,
  chip,
  selected,
}: {
  mention: Mention;
  text: string;
  chip: MentionChip | null;
  selected: boolean;
}) {
  const rangeProps = {
    'data-mention-start': mention.start,
    'data-mention-end': mention.end,
    'data-mention-kind': mention.kind ?? 'mention',
    'data-mention-value': mention.value,
    // The visible view omits delimiters. Preserve the editor's canonical text
    // separately for DOM consumers; Lexical remains the editing authority.
    'data-mention-text': text,
    'data-selected': selected ? '' : undefined,
  };
  return (
    <span
      {...rangeProps}
      className={cn(
        stylex.props(
          styles.chip,
          !chip && (mention.kind === 'pasted_text' ? styles.pastedFallback : styles.fallback),
          selected && styles.selected
        ).className,
        chip?.className
      )}
    >
      {chip ? <MentionChipContent chip={chip} text={text} /> : text}
    </span>
  );
}

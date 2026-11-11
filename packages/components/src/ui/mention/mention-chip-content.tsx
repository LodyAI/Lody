import { cn } from '@/lib/utils';
import type { Mention, MentionChip } from './mention-root';

export const CHIP_CLASS_NAME = 'box-decoration-clone';
export const CHIP_SELECTED_CLASS_NAME =
  'bg-[image:linear-gradient(Highlight,Highlight)] !text-[HighlightText]';

/**
 * Splits the range into its icon slot, label, and trailing pad. The slot
 * characters still render — as `invisible`, so they keep their exact boxes —
 * and the icon overrides `visibility` from inside the slot it covers.
 */
function MentionChipContent({ chip, text }: { chip: MentionChip; text: string }) {
  const iconSlots = Math.max(0, Math.min(chip.iconSlots ?? 1, text.length));
  const trailingSlots = Math.max(0, Math.min(chip.trailingSlots ?? 0, text.length - iconSlots));
  const iconText = text.slice(0, iconSlots);
  const labelText = text.slice(iconSlots, text.length - trailingSlots);
  const trailingText = text.slice(text.length - trailingSlots);

  return (
    <>
      {iconText ? (
        <span className="invisible relative">
          {iconText}
          {chip.icon ? (
            <span
              aria-hidden="true"
              // Confined to the slot, never hanging past it. Hanging left into
              // the preceding space looked better and was wrong twice: a slash
              // command sits at offset 0 with nothing to its left, and any
              // mention can wrap to the start of a line, where the space that
              // was supposed to absorb the overflow has been eaten by the break.
              // Neither is visible to CSS, so the icon simply stays inside.
              className="visible absolute inset-y-0 left-0 right-px flex items-center justify-end [&>*]:max-w-full"
            >
              {chip.icon}
            </span>
          ) : null}
        </span>
      ) : null}
      {labelText ? <span>{labelText}</span> : null}
      {trailingText ? <span className="invisible">{trailingText}</span> : null}
    </>
  );
}

/**
 * One committed range as the composer paints it: a chip when the resolver
 * returns one, otherwise the plain range highlight. Range offsets and identity
 * are exposed as data attributes for hit-testing and tests.
 */
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
    'data-selected': selected ? '' : undefined,
  };
  if (chip) {
    return (
      <span
        {...rangeProps}
        className={cn(CHIP_CLASS_NAME, chip.className, selected && CHIP_SELECTED_CLASS_NAME)}
      >
        <MentionChipContent chip={chip} text={text} />
      </span>
    );
  }
  return (
    <span
      data-tag=""
      {...rangeProps}
      className={cn(
        mention.kind === 'pasted_text'
          ? 'rounded-md bg-foreground/10 box-decoration-clone'
          : 'rounded-sm bg-primary/15 box-decoration-clone',
        selected && CHIP_SELECTED_CLASS_NAME
      )}
    >
      {text}
    </span>
  );
}

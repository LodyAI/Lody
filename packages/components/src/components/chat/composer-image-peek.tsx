import { useState, type CSSProperties, type ReactElement } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Popover } from '@lody/ui/popover';
import { springLinear } from '@/lib/motion';
import { themeColors } from '../../style/theme-colors.stylex';
import { themeFontSize, themeSpace } from '../../style/theme-scale.stylex';

/**
 * The peek grows out of the thumbnail with a small overshoot. The spring is a
 * CSS `linear()` curve, so the compositor runs it and Base UI still sees an
 * ordinary transition to wait on before it unmounts the card.
 */
const PEEK_STYLE = {
  '--composer-peek-spring': springLinear({ stiffness: 420, damping: 28, mass: 1 }),
} as CSSProperties;

/*
 * `springLinear` samples the curve over 1.2s, so the transition has to last as
 * long for the curve to keep its shape; it is visually still well before then.
 * Closing takes no spring: a card leaving should not bounce.
 *
 * These stay Tailwind: they sit on `Popover.Content`, a `@lody/ui` primitive,
 * and they override the primitive's own padding, gap and transition. A StyleX
 * class would compete with the primitive's own styles inside the `stylex`
 * layer, where the winner is the stylesheet's order rather than the
 * `utilities` layer's.
 */
const PEEK_CLASS =
  'origin-(--transform-origin) gap-1.5 p-1.5 transition-[opacity,transform,scale] duration-[1200ms] ease-(--composer-peek-spring) data-[starting-style]:scale-[0.35] data-[ending-style]:scale-[0.92] data-[ending-style]:duration-150 data-[ending-style]:ease-out';

const styles = stylex.create({
  image: {
    display: 'block',
    maxHeight: 'min(360px,calc(var(--available-height)-48px))',
    maxWidth: 'min(480px,calc(var(--available-width)-12px))',
    borderRadius: '9px',
    objectFit: 'contain',
  },
  caption: {
    display: 'flex',
    minWidth: 0,
    alignItems: 'baseline',
    gap: themeSpace[2],
    paddingInline: themeSpace[1],
    paddingBottom: themeSpace[0.5],
    fontSize: themeFontSize.xs,
    lineHeight: themeSpace[4],
  },
  name: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: themeColors.foreground,
  },
  size: {
    flexShrink: 0,
    color: themeColors.mutedForeground,
    fontVariantNumeric: 'tabular-nums',
  },
});

interface ComposerImagePeekProps {
  src: string;
  name: string;
  alt: string;
  /** The thumbnail; it becomes the popover's trigger. */
  trigger: ReactElement<Record<string, unknown>>;
}

/**
 * A composer attachment's preview: a card over the thumbnail rather than a
 * lightbox over the page, so the draft stays in view while you check the image.
 */
export function ComposerImagePeek({ src, name, alt, trigger }: ComposerImagePeekProps) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  return (
    <Popover.Root>
      <Popover.Trigger render={trigger} />
      <Popover.Content
        side="top"
        align="start"
        sideOffset={8}
        style={PEEK_STYLE}
        className={PEEK_CLASS}
      >
        <img
          src={src}
          alt={alt}
          onLoad={(event) =>
            setSize({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            })
          }
          {...stylex.props(styles.image)}
        />
        <div {...stylex.props(styles.caption)}>
          <span {...stylex.props(styles.name)}>{name}</span>
          {size ? (
            <span {...stylex.props(styles.size)}>
              {size.width} × {size.height}
            </span>
          ) : null}
        </div>
      </Popover.Content>
    </Popover.Root>
  );
}

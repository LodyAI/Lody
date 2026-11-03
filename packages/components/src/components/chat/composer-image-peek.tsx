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

// The sampled spring lasts 1.2s; closing keeps the original short ease-out.
const styles = stylex.create({
  panel: {
    transformOrigin: 'var(--transform-origin)',
    gap: 'calc(var(--spacing) * 1.5)',
    padding: 'calc(var(--spacing) * 1.5)',
    transitionProperty: 'opacity,transform,scale',
    transitionDuration: { default: '1200ms', ':is([data-ending-style])': '150ms' },
    transitionTimingFunction: {
      default: 'var(--composer-peek-spring)',
      ':is([data-ending-style])': 'var(--ease-out)',
    },
    scale: {
      default: '1',
      ':is([data-starting-style])': '0.35',
      ':is([data-ending-style])': '0.92',
    },
  },
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
        xstyle={styles.panel}
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

import { useState, type CSSProperties, type ReactElement } from 'react';
import { Popover } from '@lody/ui/popover';
import { springLinear } from '@/lib/motion';

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
 */
const PEEK_CLASS =
  'origin-(--transform-origin) gap-1.5 p-1.5 transition-[opacity,transform,scale] duration-[1200ms] ease-(--composer-peek-spring) data-[starting-style]:scale-[0.35] data-[ending-style]:scale-[0.92] data-[ending-style]:duration-150 data-[ending-style]:ease-out';

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
          className="block max-h-[min(360px,calc(var(--available-height)-48px))] max-w-[min(480px,calc(var(--available-width)-12px))] rounded-[9px] object-contain"
        />
        <div className="flex min-w-0 items-baseline gap-2 px-1 pb-0.5 text-xs leading-4">
          <span className="min-w-0 flex-1 truncate text-foreground">{name}</span>
          {size ? (
            <span className="shrink-0 text-muted-foreground tabular-nums">
              {size.width} × {size.height}
            </span>
          ) : null}
        </div>
      </Popover.Content>
    </Popover.Root>
  );
}

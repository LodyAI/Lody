import * as React from 'react';

import { clsx } from 'clsx';
import styles from './fade.module.css';

export type FadeProps = {
  stop?: string;
  blur?: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
  className?: string;
  background: string;
  debug?: boolean;
  style?: React.CSSProperties;
};

export const Fade = React.forwardRef<HTMLDivElement, FadeProps>(function Fade(
  { stop, blur, side = 'top', className, background, style, debug },
  ref
) {
  return (
    <div
      ref={ref}
      aria-hidden
      className={clsx(styles.root, className)}
      data-side={side}
      style={
        {
          '--stop': stop,
          '--blur': blur,
          '--background': background,
          ...(debug && {
            outline: '2px solid red',
          }),
          ...style,
        } as React.CSSProperties
      }
    />
  );
});

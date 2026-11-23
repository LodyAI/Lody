import { clsx } from 'clsx';
import { forwardRef, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';

const styles = stylex.create({
  container: { height: '100%', containerType: 'inline-size' },
});

interface ContainerQueryProviderProps {
  children: ReactNode;
  className?: string;
}

/**
 * A wrapper that establishes a CSS containment context.
 * Child components can use Tailwind's `@[640px]:` (container query) variant
 * to apply styles based on this container's width (>= 640px),
 * eliminating the layout shift that JS-based measurement caused.
 */
export const ContainerQueryProvider = forwardRef<HTMLDivElement, ContainerQueryProviderProps>(
  function ContainerQueryProvider({ children, className }, ref) {
    return (
      <div ref={ref} className={clsx(stylex.props(styles.container).className, className)}>
        {children}
      </div>
    );
  }
);

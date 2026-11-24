import { cn } from '@/lib/utils';
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
 * Child components can use container queries against this container's
 * width, eliminating the layout shift that JS-based measurement caused.
 */
export const ContainerQueryProvider = forwardRef<HTMLDivElement, ContainerQueryProviderProps>(
  function ContainerQueryProvider({ children, className }, ref) {
    return (
      <div ref={ref} className={cn(stylex.props(styles.container).className, className)}>
        {children}
      </div>
    );
  }
);

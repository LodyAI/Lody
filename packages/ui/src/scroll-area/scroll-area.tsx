import { ScrollArea as BaseScrollArea } from '@base-ui/react/scroll-area';
import * as stylex from '@stylexjs/stylex';
import {
  forwardRef,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from 'react';
import { appendClassName } from '../internal/class-name';
import { surface } from './surface';

export { nativeScrollbar } from './surface';

export type ScrollAreaAxis = 'vertical' | 'horizontal' | 'both';
export type ScrollAreaVisibility = 'hover' | 'scroll' | 'always';
export interface ScrollAreaProps extends Omit<ComponentProps<'div'>, 'children'> {
  children?: ReactNode;
  axis?: ScrollAreaAxis;
  visibility?: ScrollAreaVisibility;
  /** A 4px track for narrow horizontal tab strips. */
  compact?: boolean;
  viewportRef?: Ref<HTMLDivElement>;
  viewportClassName?: string;
  viewportStyle?: CSSProperties;
}

/** The native viewport remains the public ref for virtualization and restoration. */
export const ScrollArea = forwardRef<HTMLDivElement, ScrollAreaProps>(function ScrollArea(
  {
    children,
    axis = 'vertical',
    visibility = 'hover',
    compact = false,
    className,
    viewportRef,
    viewportClassName,
    viewportStyle,
    ...rest
  },
  ref
) {
  const track = (orientation: 'vertical' | 'horizontal') => (
    <BaseScrollArea.Scrollbar
      orientation={orientation}
      className={(state) =>
        stylex.props(
          surface.track,
          orientation === 'vertical' ? surface.verticalTrack : surface.horizontalTrack,
          compact && surface.compact,
          compact &&
            (orientation === 'vertical' ? surface.compactVertical : surface.compactHorizontal),
          visibility !== 'always' &&
            !state.scrolling &&
            !(visibility === 'hover' && state.hovering) &&
            surface.hidden
        ).className
      }
    >
      <BaseScrollArea.Thumb {...stylex.props(surface.thumb)} />
    </BaseScrollArea.Scrollbar>
  );
  return (
    <BaseScrollArea.Root
      ref={ref}
      {...rest}
      className={appendClassName(stylex.props(surface.root).className, className)}
    >
      <BaseScrollArea.Viewport
        ref={viewportRef}
        data-scroll-area-viewport=""
        className={appendClassName(
          stylex.props(surface.viewport).className,
          viewportClassName
        )}
        style={{
          ...viewportStyle,
          ...(axis === 'vertical'
            ? { overflowX: 'hidden' }
            : axis === 'horizontal'
              ? { overflowY: 'hidden' }
              : {}),
        }}
      >
        <BaseScrollArea.Content
          {...stylex.props(axis === 'vertical' && surface.verticalContent)}
          style={axis === 'vertical' ? { minWidth: 0 } : undefined}
        >
          {children}
        </BaseScrollArea.Content>
      </BaseScrollArea.Viewport>
      {axis !== 'horizontal' ? track('vertical') : null}
      {axis !== 'vertical' ? track('horizontal') : null}
      {axis === 'both' ? <BaseScrollArea.Corner /> : null}
    </BaseScrollArea.Root>
  );
});

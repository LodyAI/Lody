import { ToggleGroup as BaseToggleGroup } from '@base-ui/react/toggle-group';
import * as stylex from '@stylexjs/stylex';
import { useMemo, type ReactNode, type Ref } from 'react';
import { appendClassName } from '../internal/class-name';
import { ToggleSetContext, type ToggleShape, type ToggleSize } from './set';
import { toggleSurface as surface } from './surface';

type BaseProps<Value extends string> = BaseToggleGroup.Props<Value>;

export interface ToggleGroupProps<Value extends string> extends Omit<
  BaseProps<Value>,
  'className' | 'children'
> {
  children?: ReactNode;
  /** The height every member takes. Stated once here. Defaults to medium. */
  size?: ToggleSize;
  /** The shape every member takes. Stated once here. */
  shape?: ToggleShape;
  /** Let a set too wide for its row run onto a second one. */
  wrap?: boolean;
  /**
   * The ref arrives as a prop rather than through `forwardRef`, unlike the rest
   * of this package. `forwardRef` types a component by its props alone, so a
   * generic one keeps its type parameter only behind a cast — and this one is
   * generic so that a caller's own union reaches `value` and `onValueChange`
   * instead of widening to `string[]`. React 19 puts every ref in props anyway.
   */
  ref?: Ref<HTMLDivElement>;
  className?: string;
}

/**
 * A set of toggles answering to one value.
 *
 * It is **not** a `Tabs` strip, and the two cannot be folded together. A strip
 * picks what a person *sees*: it is a single control, so it is a tray with
 * one thing standing on it and one pill sliding between the choices. A
 * set stores what is *on*: two members can be pressed at once, which no sliding
 * pill can say, so there is no track and each member sinks on its own. Asked
 * for one choice out of several — `multiple` left off — it still draws no
 * track, because the same set with `multiple` on has to look like itself.
 *
 * The value is the list of the pressed members' `value`s, so every member in a
 * set states one; Base UI says so in development when one does not.
 *
 * Base UI makes the set one tab stop and gives the arrow keys the walking, so a
 * person tabbing through a page passes a set of eight rather than walking it.
 */
export function ToggleGroup<Value extends string>({
  size = 'medium',
  shape = 'default',
  wrap = false,
  orientation = 'horizontal',
  className,
  ref,
  ...rest
}: ToggleGroupProps<Value>) {
  const sx = stylex.props(
    surface.group,
    orientation === 'vertical' && surface.groupVertical,
    wrap && surface.groupWrap
  );
  const set = useMemo(() => ({ size, shape }), [size, shape]);
  return (
    <ToggleSetContext.Provider value={set}>
      <BaseToggleGroup
        ref={ref}
        orientation={orientation}
        {...rest}
        className={appendClassName(sx.className, className)}
        style={sx.style}
      />
    </ToggleSetContext.Provider>
  );
}

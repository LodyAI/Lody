import { Tabs as BaseTabs } from '@base-ui/react/tabs';
import * as stylex from '@stylexjs/stylex';
import {
  createContext,
  forwardRef,
  useContext,
  useMemo,
  type ComponentProps,
  type ReactNode,
} from 'react';
import { appendClassName } from '../internal/class-name';
import { disclosureSurface as surface } from './surface';

type RootBaseProps = ComponentProps<typeof BaseTabs.Root>;
type ListBaseProps = ComponentProps<typeof BaseTabs.List>;
type TabBaseProps = ComponentProps<typeof BaseTabs.Tab>;
type PanelBaseProps = ComponentProps<typeof BaseTabs.Panel>;

/** The control ladder, which a tab strip is on: 28, 32 and 36. */
export type TabsSize = 'small' | 'medium' | 'large';

export interface TabsRootProps extends Omit<RootBaseProps, 'className'> {
  className?: string;
}
export interface TabsListProps extends Omit<ListBaseProps, 'className' | 'children'> {
  children?: ReactNode;
  /** The height of the track, and of every tab in it. Defaults to medium. */
  size?: TabsSize;
  /** Take the width on offer and split it between the tabs equally. */
  stretch?: boolean;
  className?: string;
}
export interface TabsTabProps extends Omit<TabBaseProps, 'className'> {
  className?: string;
}
export interface TabsPanelProps extends Omit<PanelBaseProps, 'className'> {
  className?: string;
}

/**
 * What the strip was told, for the parts inside it. A tab's height, corner and
 * share of the width all follow from the track's, so both are stated once on
 * the list rather than repeated on every tab, where two of them could disagree.
 */
const TabsStripContext = createContext<{ size: TabsSize; stretch: boolean }>({
  size: 'medium',
  stretch: false,
});

const LIST_SIZES = {
  small: surface.trackSmall,
  medium: surface.trackMedium,
  large: surface.trackLarge,
} as const;

const INDICATOR_SIZES = {
  small: surface.indicatorSmall,
  medium: surface.indicatorMedium,
  large: surface.indicatorMedium,
} as const;

const TAB_SIZES = {
  small: surface.tabSmall,
  medium: surface.tabMedium,
  large: surface.tabMedium,
} as const;

/** The strip and the panels it swaps, stacked with the gap between them. */
export const TabsRoot = forwardRef<HTMLDivElement, TabsRootProps>(function TabsRoot(
  { className, ...rest },
  ref
) {
  const sx = stylex.props(surface.tabs);
  return (
    <BaseTabs.Root
      ref={ref}
      {...rest}
      className={appendClassName(sx.className, className)}
      style={sx.style}
    />
  );
});

/**
 * The track, with the indicator already in it.
 *
 * The indicator is rendered here rather than by the caller for the reason a
 * submenu's chevron is drawn by its row: it is not decoration a surface may
 * choose, it is how the strip says which tab you are on, and a list assembled
 * without one is a segmented control with nothing segmented. It is also the
 * part that has to come first in the DOM, which is a fact about painting order
 * rather than about the design.
 */
export const TabsList = forwardRef<HTMLDivElement, TabsListProps>(function TabsList(
  { className, children, size = 'medium', stretch = false, ...rest },
  ref
) {
  const sx = stylex.props(surface.track, LIST_SIZES[size], stretch && surface.trackStretch);
  const strip = useMemo(() => ({ size, stretch }), [size, stretch]);
  return (
    <TabsStripContext.Provider value={strip}>
      <BaseTabs.List
        ref={ref}
        {...rest}
        className={appendClassName(sx.className, className)}
        style={sx.style}
      >
        <BaseTabs.Indicator
          className={stylex.props(surface.indicator, INDICATOR_SIZES[size]).className}
        />
        {children}
      </BaseTabs.List>
    </TabsStripContext.Provider>
  );
});

/** One choice on the strip. It takes no fill of its own; the indicator has it. */
export const TabsTab = forwardRef<HTMLButtonElement, TabsTabProps>(function TabsTab(
  { className, ...rest },
  ref
) {
  const { size, stretch } = useContext(TabsStripContext);
  return (
    <BaseTabs.Tab
      ref={ref}
      {...rest}
      className={(state) =>
        appendClassName(
          stylex.props(
            surface.ring,
            surface.tab,
            TAB_SIZES[size],
            stretch && surface.tabStretch,
            state.active && surface.tabActive,
            state.disabled && surface.disabled,
            state.disabled && surface.tabDisabled
          ).className,
          className
        )
      }
    />
  );
});

/**
 * What the strip swaps. It holds a surface's own content rather than prose, so
 * it states no type of its own — only that it has no edge until the keyboard
 * reaches it, which it can: Base UI makes an active panel focusable so a person
 * arriving from the strip lands in what they just chose.
 */
export const TabsPanel = forwardRef<HTMLDivElement, TabsPanelProps>(function TabsPanel(
  { className, ...rest },
  ref
) {
  const sx = stylex.props(surface.ring, surface.tabPanel);
  return (
    <BaseTabs.Panel
      ref={ref}
      {...rest}
      className={appendClassName(sx.className, className)}
      style={sx.style}
    />
  );
});

/**
 * Tabs: the choices laid side by side, and the one panel under them that
 * changes.
 *
 * The strip is the elevation ladder read twice over — a well-rung track with
 * one thing raised out of it — which is the same pair a Switch takes, and says
 * the same thing: the track is where something sits, and the thing sitting in
 * it is the one you can press. The strip is horizontal; a vertical arrangement
 * is a different layout question and this package has not answered it yet.
 */
export const Tabs = {
  Root: TabsRoot,
  List: TabsList,
  Tab: TabsTab,
  Panel: TabsPanel,
};

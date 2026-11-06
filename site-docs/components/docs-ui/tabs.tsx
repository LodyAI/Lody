'use client';

import * as stylex from '@stylexjs/stylex';
import { clsx } from 'clsx';
import {
  Tabs as HeadlessTabs,
  TabsContent as HeadlessContent,
  TabsList as HeadlessList,
  TabsTrigger as HeadlessTrigger,
} from 'fumadocs-ui/components/ui/tabs';
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';

const styles = stylex.create({
  root: {
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    borderRadius: 'var(--radius-xl)',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'var(--color-fd-border)',
    backgroundColor: 'var(--color-fd-secondary)',
    'margin-block': 'calc(var(--spacing) * 4)',
  },
  list: {
    display: 'flex',
    gap: 'calc(var(--spacing) * 3.5)',
    color: 'var(--color-fd-secondary-foreground)',
    overflowX: 'auto',
    paddingInline: 'calc(var(--spacing) * 4)',
  },
  trigger: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 2)',
    whiteSpace: 'nowrap',
    color: {
      default: 'var(--color-fd-muted-foreground)',
      ':not([data-active]):hover': { '@media (hover: hover)': 'var(--color-fd-accent-foreground)' },
      ':is([data-active])': 'var(--color-fd-primary)',
    },
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: { default: 'transparent', ':is([data-active])': 'var(--color-fd-primary)' },
    paddingBlock: 'calc(var(--spacing) * 2)',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
    fontWeight: 'var(--font-weight-medium)',
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    transitionDuration: 'var(--default-transition-duration)',
    transitionTimingFunction: 'var(--default-transition-timing-function)',
    pointerEvents: { default: null, ':disabled': 'none' },
    opacity: { default: null, ':disabled': 0.5 },
    ':is(*) svg': { width: 'calc(var(--spacing) * 4)', height: 'calc(var(--spacing) * 4)' },
  },
  label: {
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
    fontWeight: 'var(--font-weight-medium)',
    'margin-block': 'auto',
    'margin-inline-end': 'auto',
  },
  content: {
    padding: 'calc(var(--spacing) * 4)',
    fontSize: '.9375rem',
    backgroundColor: 'var(--color-fd-background)',
    borderRadius: 'var(--radius-xl)',
    outlineStyle: 'none',
    display: { default: 'block', ':is([data-inactive])': 'none' },
    ':is(*) > :first-child': { marginTop: 0 },
    ':is(*) > :last-child': { marginBottom: 0 },
    ':is(*) > figure:only-child': { margin: 'calc(var(--spacing) * -4)', borderStyle: 'none' },
  },
});

const TabsContext = createContext<{ items?: string[]; collection: string[] } | null>(null);
function useTabContext() {
  const context = useContext(TabsContext);
  if (!context) throw new Error('You must wrap your component in <Tabs>');
  return context;
}

export function TabsList({
  className,
  style,
  xstyle,
  ...props
}: ComponentProps<typeof HeadlessList> & { xstyle?: stylex.StyleXStyles }) {
  const sx = stylex.props(styles.list, xstyle);
  return (
    <HeadlessList
      {...props}
      className={(state) =>
        clsx(
          'not-prose',
          sx.className,
          typeof className === 'function' ? className(state) : className
        )
      }
      style={
        sx.style
          ? (state) => ({ ...sx.style, ...(typeof style === 'function' ? style(state) : style) })
          : style
      }
    />
  );
}

export function TabsTrigger({
  className,
  style,
  xstyle,
  ...props
}: ComponentProps<typeof HeadlessTrigger> & { xstyle?: stylex.StyleXStyles }) {
  const sx = stylex.props(styles.trigger, xstyle);
  return (
    <HeadlessTrigger
      {...props}
      className={(state) =>
        clsx(sx.className, typeof className === 'function' ? className(state) : className)
      }
      style={
        sx.style
          ? (state) => ({ ...sx.style, ...(typeof style === 'function' ? style(state) : style) })
          : style
      }
    />
  );
}

export interface TabsProps extends Omit<
  ComponentProps<typeof HeadlessTabs>,
  'value' | 'onValueChange'
> {
  items?: string[];
  defaultIndex?: number;
  label?: ReactNode;
  xstyle?: stylex.StyleXStyles;
}

export function Tabs({
  className,
  style,
  xstyle,
  items,
  label,
  defaultIndex = 0,
  defaultValue = items ? escapeValue(items[defaultIndex]) : undefined,
  children,
  ...props
}: TabsProps) {
  const [value, setValue] = useState(defaultValue);
  const collection = useMemo<string[]>(() => [], []);
  const context = useMemo(() => ({ items, collection }), [items, collection]);
  const sx = stylex.props(styles.root, xstyle);
  return (
    <HeadlessTabs
      value={value}
      onValueChange={(next) => {
        if (items && !items.some((item) => escapeValue(item) === next)) return;
        setValue(next);
      }}
      className={(state) =>
        clsx(sx.className, typeof className === 'function' ? className(state) : className)
      }
      style={
        sx.style
          ? (state) => ({ ...sx.style, ...(typeof style === 'function' ? style(state) : style) })
          : style
      }
      {...props}
    >
      {items && (
        <TabsList>
          {label && <span {...stylex.props(styles.label)}>{label}</span>}
          {items.map((item) => (
            <TabsTrigger key={item} value={escapeValue(item)}>
              {item}
            </TabsTrigger>
          ))}
        </TabsList>
      )}
      <TabsContext.Provider value={context}>{children}</TabsContext.Provider>
    </HeadlessTabs>
  );
}

export interface TabProps extends Omit<ComponentProps<typeof HeadlessContent>, 'value'> {
  value?: string;
  xstyle?: stylex.StyleXStyles;
}
export function Tab({ value, ...props }: TabProps) {
  const { items } = useTabContext();
  const index = useCollectionIndex(value === undefined && items !== undefined);
  const resolved = value ?? items?.at(index);
  if (!resolved)
    throw new Error(
      'Failed to resolve tab `value`, please pass a `value` prop to the Tab component.'
    );
  return <TabsContent value={escapeValue(resolved)} {...props} />;
}

export function TabsContent({
  className,
  style,
  xstyle,
  ...props
}: ComponentProps<typeof HeadlessContent> & { xstyle?: stylex.StyleXStyles }) {
  const sx = stylex.props(styles.content, xstyle);
  return (
    <HeadlessContent
      keepMounted
      {...props}
      className={(state) =>
        clsx(sx.className, typeof className === 'function' ? className(state) : className)
      }
      style={
        sx.style
          ? (state) => ({ ...sx.style, ...(typeof style === 'function' ? style(state) : style) })
          : style
      }
    />
  );
}

function useCollectionIndex(enabled: boolean) {
  const key = useId();
  const { collection } = useTabContext();
  useEffect(
    () => () => {
      const index = collection.indexOf(key);
      if (index !== -1) collection.splice(index, 1);
    },
    [collection, key]
  );
  const index = collection.indexOf(key);
  if (enabled && index === -1) collection.push(key);
  else if (!enabled && index !== -1) collection.splice(index, 1);
  return collection.indexOf(key);
}

function escapeValue(value: string) {
  return value.toLowerCase().replace(/\s/, '-');
}

import { Dialog } from '@base-ui/react/dialog';
import * as stylex from '@stylexjs/stylex';
import {
  SearchDialogList as KeyboardSearchList,
  SearchDialogListItem,
  useSearch,
  type SearchItemType,
} from 'fumadocs-ui/components/dialog/search';
import { useI18n } from 'fumadocs-ui/contexts/i18n';
import { SearchIcon } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';

const fadeIn = stylex.keyframes({ from: { opacity: 0 }, to: { opacity: 1 } });
const fadeOut = stylex.keyframes({ from: { opacity: 1 }, to: { opacity: 0 } });
const dialogIn = stylex.keyframes({
  from: { transform: 'scale(1.06)', opacity: 0 },
  to: { transform: 'scale(1)' },
});
const dialogOut = stylex.keyframes({
  from: { transform: 'scale(1)' },
  to: { transform: 'scale(1.04)', opacity: 0 },
});
const pulse = stylex.keyframes({ '50%': { opacity: 0.5 } });

const styles = stylex.create({
  overlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 50,
    backdropFilter: 'blur(var(--blur-xs, 4px))',
    backgroundColor: 'var(--color-fd-overlay)',
    animationName: {
      default: 'none',
      ':is([data-open])': fadeIn,
      ':is([data-closed])': fadeOut,
    },
    animationDuration: '300ms',
    animationTimingFunction: 'ease',
  },
  popup: {
    position: 'fixed',
    left: '50%',
    top: { default: 'calc(var(--spacing) * 4)', '@media (min-width: 48rem)': 'calc(50% - 250px)' },
    zIndex: 50,
    width: 'calc(100% - 1rem)',
    maxWidth: 'var(--breakpoint-sm, 40rem)',
    translate: '-50% 0',
    borderRadius: 'var(--radius-xl, 0.75rem)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--color-fd-border)',
    backgroundColor: 'var(--color-fd-popover)',
    color: 'var(--color-fd-popover-foreground)',
    boxShadow: '0 25px 50px -12px rgb(0 0 0 / 0.25)',
    overflow: 'hidden',
    outlineStyle: { default: null, ':focus-visible': 'none' },
    animationName: {
      default: 'none',
      ':is([data-open])': dialogIn,
      ':is([data-closed])': dialogOut,
    },
    animationDuration: '300ms',
    animationTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)',
    ':is(*) > *': {
      borderBottomWidth: 1,
      borderBottomStyle: 'solid',
      borderBottomColor: 'var(--color-fd-border)',
    },
    ':is(*) > :last-child': { borderBottomWidth: 0 },
    ':is(*) > [data-empty="true"]': { borderBottomWidth: 0 },
    ':is(*) > :has(+ :last-child[data-empty="true"])': { borderBottomWidth: 0 },
  },
  title: { display: 'none' },
  header: {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 2)',
    padding: 'calc(var(--spacing) * 3)',
  },
  input: {
    width: 0,
    flex: '1',
    backgroundColor: 'transparent',
    fontSize: 'var(--text-lg, 1.125rem)',
    lineHeight: 'var(--text-lg--line-height, calc(1.75 / 1.125))',
    '::placeholder': { color: 'var(--color-fd-muted-foreground)' },
    outlineStyle: { default: null, ':focus-visible': 'none' },
  },
  icon: {
    width: 'calc(var(--spacing) * 5)',
    height: 'calc(var(--spacing) * 5)',
    color: 'var(--color-fd-muted-foreground)',
  },
  loading: {
    animationName: pulse,
    animationDuration: '2s',
    animationTimingFunction: 'cubic-bezier(0.4, 0, 0.6, 1)',
    animationIterationCount: 'infinite',
  },
  close: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 'calc(var(--spacing) * 1)',
    borderRadius: 'var(--radius-md)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--color-fd-border)',
    paddingInline: 'calc(var(--spacing) * 2)',
    paddingBlock: 'calc(var(--spacing) * 1.5)',
    fontSize: 'var(--text-xs, 0.75rem)',
    lineHeight: 'var(--text-xs--line-height, calc(1 / 0.75))',
    fontWeight: 'var(--font-weight-medium, 500)',
    fontFamily: 'var(--font-mono)',
    fontFeatureSettings: 'var(--font-mono--font-feature-settings, normal)',
    fontVariationSettings: 'var(--font-mono--font-variation-settings, normal)',
    color: {
      default: 'var(--color-fd-muted-foreground)',
      '@media (hover: hover)': { ':hover': 'var(--color-fd-accent-foreground)' },
    },
    backgroundColor: {
      default: 'transparent',
      '@media (hover: hover)': { ':hover': 'var(--color-fd-accent)' },
    },
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    transitionDuration: '100ms',
    transitionTimingFunction: 'var(--default-transition-timing-function)',
    outlineStyle: { default: null, ':focus-visible': 'none' },
    boxShadow: { default: null, ':focus-visible': '0 0 0 2px var(--color-fd-ring)' },
    pointerEvents: { default: 'auto', ':disabled': 'none' },
    opacity: { default: 1, ':disabled': 0.5 },
  },
  list: {
    overflow: 'hidden',
    height: 'var(--fd-animated-height)',
    transitionProperty: 'height',
    transitionDuration: 'var(--default-transition-duration, 150ms)',
    transitionTimingFunction: 'var(--default-transition-timing-function)',
    ':is(*) > div': {
      width: '100%',
      display: 'flex',
      flexDirection: 'column',
      overflowY: 'auto',
      maxHeight: 460,
      padding: 'calc(var(--spacing) * 1)',
    },
    ':is([data-empty="true"]) > div': { display: 'none' },
  },
  empty: {
    paddingBlock: 'calc(var(--spacing) * 12)',
    textAlign: 'center',
    fontSize: 'var(--text-sm, 0.875rem)',
    lineHeight: 'var(--text-sm--line-height, calc(1.25 / 0.875))',
    color: 'var(--color-fd-muted-foreground)',
  },
  result: {
    position: 'relative',
    userSelect: 'none',
    flexShrink: 0,
    paddingInline: 'calc(var(--spacing) * 2.5)',
    paddingBlock: 'calc(var(--spacing) * 2)',
    textAlign: 'start',
    fontSize: 'var(--text-sm, 0.875rem)',
    lineHeight: 'var(--text-sm--line-height, calc(1.25 / 0.875))',
    overflow: 'hidden',
    borderRadius: 'var(--radius-lg)',
    backgroundColor: {
      default: 'transparent',
      ':is([aria-selected="true"])': 'var(--color-fd-accent)',
    },
    color: {
      default: 'inherit',
      ':is([aria-selected="true"])': 'var(--color-fd-accent-foreground)',
    },
    ':is(*) > div:first-child': {
      display: 'inline-flex',
      alignItems: 'center',
      color: 'var(--color-fd-muted-foreground)',
      fontSize: 'var(--text-xs, 0.75rem)',
      lineHeight: 'var(--text-xs--line-height, calc(1 / 0.75))',
    },
    ':is(*) > div:first-child:empty': { display: 'none' },
    ':is(*) > div:last-child': { minWidth: 0, fontWeight: 'var(--font-weight-medium, 500)' },
    ':is(*) p': { minWidth: 0 },
    ':is(*) strong': {
      color: 'var(--color-fd-accent-foreground)',
      fontWeight: 'var(--font-weight-medium, 500)',
    },
    ':is(*) [data-docs-search-highlight]': {
      color: 'var(--color-fd-primary)',
      textDecorationLine: 'underline',
    },
    ':is(*) code': {
      borderWidth: 1,
      borderStyle: 'solid',
      borderColor: 'var(--color-fd-border)',
      borderRadius: 'var(--radius-md)',
      paddingInline: '1px',
      backgroundColor: 'var(--color-fd-secondary)',
      color: 'var(--color-fd-secondary-foreground)',
    },
  },
});

export function SearchDialogOverlay() {
  return <Dialog.Backdrop {...stylex.props(styles.overlay)} />;
}

export function SearchDialogContent({ children }: { children: ReactNode }) {
  const { text } = useI18n();
  return (
    <Dialog.Portal>
      <Dialog.Popup
        id="fd-search-dialog-content"
        aria-describedby={undefined}
        {...stylex.props(styles.popup)}
      >
        <Dialog.Title {...stylex.props(styles.title)}>{text.search}</Dialog.Title>
        {children}
      </Dialog.Popup>
    </Dialog.Portal>
  );
}

export function SearchDialogHeader({ children }: { children: ReactNode }) {
  return <div {...stylex.props(styles.header)}>{children}</div>;
}

export function SearchDialogInput() {
  const { text } = useI18n();
  const { search, onSearchChange } = useSearch();
  return (
    <input
      {...stylex.props(styles.input)}
      value={search}
      onChange={(event) => onSearchChange(event.target.value)}
      placeholder={text.search}
    />
  );
}

export function SearchDialogIcon() {
  const { isLoading } = useSearch();
  return <SearchIcon {...stylex.props(styles.icon, isLoading && styles.loading)} />;
}

export function SearchDialogClose() {
  const { onOpenChange } = useSearch();
  return (
    <button type="button" {...stylex.props(styles.close)} onClick={() => onOpenChange(false)}>
      ESC
    </button>
  );
}

function EmptyResults() {
  const { text } = useI18n();
  return <div {...stylex.props(styles.empty)}>{text.searchNoResult}</div>;
}

function Result(props: ComponentProps<typeof SearchDialogListItem>) {
  return <SearchDialogListItem {...props} className={stylex.props(styles.result).className} />;
}

/** Keep Fumadocs' IME/arrow/Enter navigation, active-row scrolling and height observer. */
export function SearchDialogList({ items }: { items: SearchItemType[] | null }) {
  return (
    <KeyboardSearchList
      items={items}
      className={stylex.props(styles.list).className}
      Empty={EmptyResults}
      Item={(props) => <Result {...props} />}
    />
  );
}

import * as stylex from '@stylexjs/stylex';
import Link from 'fumadocs-core/link';
import { useI18n } from 'fumadocs-ui/contexts/i18n';
import { useSearchContext } from 'fumadocs-ui/contexts/search';
import { useDocsLayout } from 'fumadocs-ui/layouts/docs';
import type {
  FullSearchTriggerProps,
  SearchTriggerProps,
} from 'fumadocs-ui/layouts/shared/slots/search-trigger';
import { Search, SidebarIcon } from 'lucide-react';
import type { ComponentProps } from 'react';

const styles = stylex.create({
  header: {
    gridArea: 'header',
    position: 'sticky',
    top: 'var(--fd-docs-row-1)',
    zIndex: 30,
    display: { default: 'flex', '@media (min-width: 48rem)': 'none' },
    alignItems: 'center',
    paddingInlineStart: 'calc(var(--spacing) * 4)',
    paddingInlineEnd: 'calc(var(--spacing) * 2.5)',
    borderBottomWidth: 1,
    borderBottomStyle: 'solid',
    borderBottomColor: 'var(--color-fd-border, currentColor)',
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    transitionTimingFunction: 'var(--default-transition-timing-function)',
    transitionDuration: 'var(--default-transition-duration)',
    backdropFilter: 'blur(var(--blur-sm, 8px))',
    height: 'var(--fd-header-height)',
    backgroundColor: {
      default: null,
      ':is([data-transparent="false"])':
        'color-mix(in oklab, var(--color-fd-background) 80%, transparent)',
    },
  },
  title: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 2.5)',
    fontWeight: {
      default: 'var(--font-weight-semibold)',
      ':is(#nd-sidebar *)': 'var(--font-weight-medium)',
    },
    fontSize: { default: null, ':is(#nd-sidebar *)': '0.9375rem' },
    marginInlineEnd: { default: null, ':is(#nd-sidebar *)': 'auto' },
  },
  spacer: { flex: '1' },
  button: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 'var(--radius-md)',
    padding: 'calc(var(--spacing) * 2)',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
    fontWeight: 'var(--font-weight-medium)',
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    transitionDuration: '100ms',
    transitionTimingFunction: 'var(--default-transition-timing-function)',
    pointerEvents: { default: null, ':disabled': 'none' },
    opacity: { default: null, ':disabled': 0.5 },
    outlineStyle: { default: null, ':focus-visible': 'none' },
    boxShadow: { default: null, ':focus-visible': '0 0 0 2px var(--color-fd-ring)' },
  },
  ghostButton: {
    backgroundColor: {
      default: null,
      ':hover': { default: null, '@media (hover: hover)': 'var(--color-fd-accent)' },
    },
    color: {
      default: null,
      ':hover': { default: null, '@media (hover: hover)': 'var(--color-fd-accent-foreground)' },
    },
  },
  headerButton: { padding: 'calc(var(--spacing) * 2)' },
  searchButton: {
    ':is(#nd-subnav *)': { padding: 'calc(var(--spacing) * 2)' },
  },
  primaryButton: {
    backgroundColor: {
      default: 'var(--color-fd-primary)',
      ':hover': {
        default: null,
        '@media (hover: hover)': 'color-mix(in oklab, var(--color-fd-primary) 80%, transparent)',
      },
    },
    color: 'var(--color-fd-primary-foreground)',
  },
  outlineButton: {
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--color-fd-border, currentColor)',
  },
  secondaryButton: {
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--color-fd-border, currentColor)',
    backgroundColor: {
      default: 'var(--color-fd-secondary)',
      ':hover': { default: null, '@media (hover: hover)': 'var(--color-fd-accent)' },
    },
    color: {
      default: 'var(--color-fd-secondary-foreground)',
      ':hover': { default: null, '@media (hover: hover)': 'var(--color-fd-accent-foreground)' },
    },
  },
  smallButton: {
    gap: 'calc(var(--spacing) * 1)',
    paddingInline: 'calc(var(--spacing) * 2)',
    paddingBlock: 'calc(var(--spacing) * 1.5)',
    fontSize: 'var(--text-xs)',
    lineHeight: 'var(--text-xs--line-height)',
  },
  iconButton: {
    padding: 'calc(var(--spacing) * 1.5)',
    ':is(*) svg': {
      width: 'calc(var(--spacing) * 5)',
      height: 'calc(var(--spacing) * 5)',
    },
  },
  smallIconButton: {
    padding: 'calc(var(--spacing) * 1.5)',
    ':is(*) svg': {
      width: 'calc(var(--spacing) * 4.5)',
      height: 'calc(var(--spacing) * 4.5)',
    },
  },
  tinyButton: {
    padding: 'calc(var(--spacing) * 1)',
    ':is(*) svg': {
      width: 'calc(var(--spacing) * 4)',
      height: 'calc(var(--spacing) * 4)',
    },
  },
  fullSearch: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 2)',
    borderRadius: 'var(--radius-lg)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--color-fd-border, currentColor)',
    backgroundColor: {
      default: 'color-mix(in oklab, var(--color-fd-secondary) 50%, transparent)',
      ':hover': { default: null, '@media (hover: hover)': 'var(--color-fd-accent)' },
    },
    color: {
      default: 'var(--color-fd-muted-foreground)',
      ':hover': { default: null, '@media (hover: hover)': 'var(--color-fd-accent-foreground)' },
    },
    padding: 'calc(var(--spacing) * 1.5)',
    paddingInlineStart: 'calc(var(--spacing) * 2)',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    transitionDuration: 'var(--default-transition-duration)',
    transitionTimingFunction: 'var(--default-transition-timing-function)',
  },
  searchIcon: { width: 'calc(var(--spacing) * 4)', height: 'calc(var(--spacing) * 4)' },
  hotkeys: { marginInlineStart: 'auto', display: 'inline-flex', gap: 'calc(var(--spacing) * 0.5)' },
  hotkey: {
    borderRadius: 'var(--radius-md)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--color-fd-border, currentColor)',
    backgroundColor: 'var(--color-fd-background)',
    paddingInline: 'calc(var(--spacing) * 1.5)',
  },
});

export function DocsNavTitle({
  href: defaultUrl = '/',
  className,
  style,
  ...props
}: ComponentProps<'a'>) {
  const { url = defaultUrl, title } = useDocsLayout().props.nav ?? {};
  const sx = stylex.props(styles.title);
  const linkProps = {
    href: url,
    ...props,
    className: [sx.className, className].filter(Boolean).join(' '),
    style: { ...sx.style, ...style },
  };
  if (typeof title === 'function') return title(linkProps);
  return <Link {...linkProps}>{title}</Link>;
}

function SearchButton({
  hideIfDisabled,
  className,
  style,
  size = 'icon-sm',
  color = 'ghost',
  variant: _variant,
  ...props
}: SearchTriggerProps) {
  const { enabled, setOpenSearch } = useSearchContext();
  if (hideIfDisabled && !enabled) return null;
  const sx = stylex.props(
    styles.button,
    color !== null && color !== 'primary' && styles.ghostButton,
    color === 'primary' && styles.primaryButton,
    color === 'outline' && styles.outlineButton,
    color === 'secondary' && styles.secondaryButton,
    size === 'sm' && styles.smallButton,
    size === 'icon' && styles.iconButton,
    size === 'icon-sm' && styles.smallIconButton,
    size === 'icon-xs' && styles.tinyButton,
    styles.searchButton
  );
  return (
    <button
      type="button"
      {...props}
      data-search=""
      aria-label="Open Search"
      className={[sx.className, className].filter(Boolean).join(' ')}
      style={{ ...sx.style, ...style }}
      onClick={() => setOpenSearch(true)}
    >
      <Search />
    </button>
  );
}

function FullSearchButton({ hideIfDisabled, className, style, ...props }: FullSearchTriggerProps) {
  const { enabled, hotKey, setOpenSearch } = useSearchContext();
  const { text } = useI18n();
  if (hideIfDisabled && !enabled) return null;
  const sx = stylex.props(styles.fullSearch);
  return (
    <button
      type="button"
      data-search-full=""
      {...props}
      className={[sx.className, className].filter(Boolean).join(' ')}
      style={{ ...sx.style, ...style }}
      onClick={() => setOpenSearch(true)}
    >
      <Search {...stylex.props(styles.searchIcon)} />
      {text.search}
      <div {...stylex.props(styles.hotkeys)}>
        {hotKey.map((key, index) => (
          <kbd key={index} {...stylex.props(styles.hotkey)}>
            {key.display}
          </kbd>
        ))}
      </div>
    </button>
  );
}

export function DocsSearchTrigger(props: SearchTriggerProps) {
  const { searchToggle } = useDocsLayout().props;
  if (searchToggle.components?.sm) return searchToggle.components.sm;
  return <SearchButton {...props} {...searchToggle.sm} />;
}

export function DocsFullSearchTrigger(props: FullSearchTriggerProps) {
  const { searchToggle } = useDocsLayout().props;
  if (searchToggle.components?.lg) return searchToggle.components.lg;
  return <FullSearchButton {...props} {...searchToggle.full} />;
}

export function DocsLayoutHeader({ className, style, ...props }: ComponentProps<'header'>) {
  const {
    isNavTransparent,
    slots,
    props: { nav },
  } = useDocsLayout();
  if (nav?.component) return nav.component;
  const sx = stylex.props(styles.header);
  return (
    <header
      id="nd-subnav"
      data-transparent={isNavTransparent}
      {...props}
      className={[sx.className, className].filter(Boolean).join(' ')}
      style={{ ...sx.style, ...style }}
    >
      {slots.navTitle && <slots.navTitle />}
      <div {...stylex.props(styles.spacer)}>{nav?.children}</div>
      {slots.searchTrigger && <slots.searchTrigger.sm hideIfDisabled />}
      {slots.sidebar && (
        <slots.sidebar.trigger
          {...stylex.props(
            styles.button,
            styles.ghostButton,
            styles.smallIconButton,
            styles.headerButton
          )}
        >
          <SidebarIcon />
        </slots.sidebar.trigger>
      )}
    </header>
  );
}

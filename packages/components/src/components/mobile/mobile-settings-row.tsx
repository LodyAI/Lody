import type { ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { withClassName } from '@/lib/stylex';
// The theme tokens are imported by path, not by the `@/` alias: the StyleX
// compiler links a theme file on its own and does not follow bundler aliases.
import { themeColors } from '../../style/theme-colors.stylex';
import { themeFontWeight, themeRadius, themeSpace } from '../../style/theme-scale.stylex';

/* Shared mobile form-row primitives for the settings sub-pages. They
   render the home-style "section heading + rounded card + divided
   rows" pattern (see `MobileChatListCard` for the list-side analogue)
   so each settings sub-page can ditch the desktop-oriented
   `CompactSection` / `CompactRow` grid on mobile and keep the same
   visual family as the rest of the mobile app.
   Pure-render — no isMobile gating here. Sub-pages decide whether to
   render the mobile or the desktop layout. */

const styles = stylex.create({
  /** A group of settings: its heading, then its rows. */
  section: {
    marginTop: themeSpace[5],
    ':first-child': { marginTop: themeSpace[3] },
  },
  /** The heading block: the title and its actions, then the description. */
  sectionHeader: { paddingInline: themeSpace[5], paddingBottom: themeSpace[1.5] },
  sectionHeaderRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: themeSpace[2],
  },
  sectionTitle: {
    minWidth: 0,
    fontSize: '0.82rem',
    fontWeight: themeFontWeight.normal,
    color: themeColors.mutedForeground,
  },
  sectionActions: { display: 'flex', flexShrink: 0, alignItems: 'center', gap: themeSpace[1] },
  sectionDescription: {
    marginTop: themeSpace[0.5],
    fontSize: '0.78rem',
    color: 'hsl(var(--muted-foreground) / 0.8)',
  },
  /** The card a group's rows sit in. */
  card: {
    marginInline: themeSpace[3],
    overflow: 'hidden',
    borderRadius: themeRadius['2xl'],
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'hsl(var(--border) / 0.6)',
    backgroundColor: themeColors.card,
  },
  /** One row: the label column and the control beside it. */
  row: {
    display: 'flex',
    gap: themeSpace[3],
    paddingInline: themeSpace[4],
    paddingBlock: themeSpace[3],
  },
  /** A row whose control sits under the label instead of beside it. */
  rowStacked: { flexDirection: 'column', alignItems: 'stretch' },
  rowInline: { alignItems: 'center' },
  /** The label column: it takes the remaining width so the copy wraps or
      truncates instead of pushing the control off-screen. */
  rowBody: { minWidth: 0, flexGrow: 1, flexShrink: 1, flexBasis: '0%' },
  /** The row's label. */
  rowLabel: {
    fontSize: '0.95rem',
    fontWeight: themeFontWeight.normal,
    lineHeight: 1.25,
    color: themeColors.foreground,
  },
  /** The row's helper copy. */
  rowHelper: {
    marginTop: themeSpace[0.5],
    fontSize: '0.78rem',
    lineHeight: 1.25,
    color: themeColors.mutedForeground,
  },
  /** The control column: it hugs its content against a narrow viewport. */
  rowControl: { display: 'flex', flexShrink: 0, alignItems: 'center', gap: themeSpace[2] },
  /** The row's trailing mark. */
  rowTrailing: { flexShrink: 0, color: 'hsl(var(--muted-foreground) / 0.6)' },
  /** A stacked control, under the label. */
  rowStackedControl: { paddingInline: themeSpace[4], paddingBottom: themeSpace[3] },
  /** A stacked control with no label above it: it rides up under the row. */
  rowStackedControlTight: { marginTop: 'calc(-1 * var(--spacing))' },
  /** The rule between two rows of a card. */
  rowDivider: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: themeColors.border,
  },
  /** A row that opens something: the whole line answers the pointer. */
  rowButton: {
    display: 'block',
    width: '100%',
    textAlign: 'left',
    transitionProperty:
      'color, background-color, border-color, text-decoration-color, fill, stroke',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
    backgroundColor: { default: null, ':active': 'hsl(var(--muted) / 0.4)' },
  },
});

export type MobileSettingsSectionProps = {
  title?: ReactNode;
  description?: ReactNode;
  /** Optional action chip(s) (`...`) rendered next to the heading. */
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Drops the rounded card frame, e.g. for sections that need to
     render their own custom container (a list of rows that are not
     inside a single card, etc.). */
  noCard?: boolean;
};

export function MobileSettingsSection({
  title,
  description,
  actions,
  children,
  className,
  noCard = false,
}: MobileSettingsSectionProps) {
  return (
    <section {...withClassName(stylex.props(styles.section), className)}>
      {title || actions ? (
        <header {...stylex.props(styles.sectionHeader)}>
          <div {...stylex.props(styles.sectionHeaderRow)}>
            {title ? <h2 {...stylex.props(styles.sectionTitle)}>{title}</h2> : <span />}
            {actions ? <div {...stylex.props(styles.sectionActions)}>{actions}</div> : null}
          </div>
          {/* Description gets its own full-width line under the title/action
             row — squeezing it into the title column wrapped it to 3+ lines
             next to wide actions (e.g. the CLI Token "Create token" button)
             on narrow viewports. */}
          {description ? <p {...stylex.props(styles.sectionDescription)}>{description}</p> : null}
        </header>
      ) : null}
      {noCard ? children : <div {...stylex.props(styles.card)}>{children}</div>}
    </section>
  );
}

export type MobileSettingsRowProps = {
  /** Leading label text. Required because rows without a label read
     as random standalone controls — wrap a label-less control in a
     bare `<div>` inside the card instead. */
  label: ReactNode;
  /** Secondary line under the label (helper text). Optional. */
  helper?: ReactNode;
  /** The control (Switch, Select trigger, button, text value, etc.).
     Aligned to the right of the row on a single line by default;
     pass `stack` to drop it below the label instead. */
  children?: ReactNode;
  /** Render the control under the label rather than to the right.
     Use for wider controls (a long Select trigger, a textarea, a
     row of chips) where a side-by-side layout would clip. */
  stack?: boolean;
  /** Renders a top-border divider — set by `MobileSettingsRowGroup`
     on every row after the first. Manual callers should pass it
     themselves. */
  hasDivider?: boolean;
  /** Optional click handler — when present the row is rendered as a
     button with an `active:bg-muted/40` press state. */
  onClick?: () => void;
  /** Trailing chevron (or other icon) rendered to the right of the
     control. Common for drill-into rows. */
  trailing?: ReactNode;
  className?: string;
};

export function MobileSettingsRow({
  label,
  helper,
  children,
  stack = false,
  hasDivider = false,
  onClick,
  trailing,
  className,
}: MobileSettingsRowProps) {
  /* The label column always takes the remaining width (grows, shrinks, and
     starts from nothing) so long labels truncate or wrap instead of pushing
     the control off-screen. The control column hugs its content against
     narrow viewports. */
  const body = (
    <div
      {...withClassName(
        stylex.props(styles.row, stack ? styles.rowStacked : styles.rowInline),
        className
      )}
    >
      <div {...stylex.props(styles.rowBody)}>
        {typeof label === 'string' ? <p {...stylex.props(styles.rowLabel)}>{label}</p> : label}
        {helper ? (
          typeof helper === 'string' ? (
            <p {...stylex.props(styles.rowHelper)}>{helper}</p>
          ) : (
            <div {...stylex.props(styles.rowHelper)}>{helper}</div>
          )
        ) : null}
      </div>
      {children != null && !stack ? (
        <div {...stylex.props(styles.rowControl)}>{children}</div>
      ) : null}
      {trailing != null && !stack ? (
        <div {...stylex.props(styles.rowTrailing)}>{trailing}</div>
      ) : null}
    </div>
  );

  const stackedControl =
    children != null && stack ? (
      <div {...stylex.props(styles.rowStackedControl, !label && styles.rowStackedControlTight)}>
        {children}
      </div>
    ) : null;

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        {...stylex.props(styles.rowButton, hasDivider && styles.rowDivider)}
      >
        {body}
        {stackedControl}
      </button>
    );
  }

  return (
    <div {...stylex.props(hasDivider && styles.rowDivider)}>
      {body}
      {stackedControl}
    </div>
  );
}

/* Convenience wrapper that auto-applies `hasDivider` to every row
   after the first, so callers don't have to thread the index
   themselves. Just put `<MobileSettingsRow>` children inside and
   they'll get the divider for free. */
export function MobileSettingsRowGroup({ children }: { children: ReactNode }) {
  const items = Array.isArray(children) ? children : [children];
  return (
    <>
      {items
        .filter((node) => node != null && node !== false)
        .map((node, index) => {
          if (typeof node !== 'object' || node === null || !('props' in node)) {
            return node;
          }
          const element = node as { props: Record<string, unknown>; key?: string | number | null };
          const existingDivider = element.props.hasDivider as boolean | undefined;
          return (
            <RowWithDivider key={element.key ?? index} hasDivider={existingDivider ?? index > 0}>
              {node}
            </RowWithDivider>
          );
        })}
    </>
  );
}

/* Helper that injects `hasDivider` into a child `<MobileSettingsRow>`
   without forcing the caller to use `React.cloneElement` themselves. */
function RowWithDivider({ hasDivider, children }: { hasDivider: boolean; children: ReactNode }) {
  if (
    typeof children !== 'object' ||
    children === null ||
    !('type' in children) ||
    children.type !== MobileSettingsRow
  ) {
    return <>{children}</>;
  }
  const element = children as React.ReactElement<MobileSettingsRowProps>;
  return <MobileSettingsRow {...element.props} hasDivider={hasDivider} />;
}

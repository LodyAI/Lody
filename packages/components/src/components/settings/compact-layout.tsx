import React, { forwardRef, type ComponentProps, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { ArrowUpRight, ChevronRight } from 'lucide-react';
import { withClassName } from '@/lib/stylex';
import { settingsBoxed } from './material.stylex';
import { settingsSurface as surface } from './surface';

/**
 * The settings card for a standalone catalog row (MCP server, Agent role,
 * provider): the same card a section draws. Spread it with `stylex.props` so a
 * caller's layout classes compose rather than restating the material.
 */
export const settingsCard = surface.card;

/**
 * A group of records a person manages (servers, roles, repositories, machines,
 * projects) rather than questions about a preference: it keeps its card even
 * on a flat page, since the box says "this set" and the rules between records
 * carry the eye from a name to its controls.
 */
export const settingsRecordsCard = [settingsBoxed, surface.card] as const;

interface CompactSectionProps {
  title?: string;
  description?: string;
  actions?: ReactNode;
  /** Free-form content on the right of the header (rendered as-is, unlike
   * `actions` which are coerced into icon buttons). */
  headerRight?: ReactNode;
  /** A group that destroys something — leave, transfer, delete — says so on its card. */
  tone?: 'default' | 'danger';
  /** A collection of records rather than preferences keeps its card on a flat page. */
  boxed?: boolean;
  children: ReactNode;
  className?: string;
}

interface CompactRowProps {
  label: string;
  helper?: ReactNode;
  children?: ReactNode;
  className?: string;
  alignTop?: boolean;
  /**
   * The row's control cannot be used here. Its name steps back with the
   * control, and the helper should say why.
   */
  disabled?: boolean;
}

export function CompactSection({
  title,
  description,
  actions,
  headerRight,
  tone = 'default',
  boxed = false,
  children,
  className,
}: CompactSectionProps) {
  // The section owns the lines between its rows, so every child is one line of
  // the card whether or not it is a `CompactRow`.
  const lines = React.Children.toArray(children);
  return (
    <section
      {...stylex.props(
        surface.section,
        Boolean(title || headerRight) && surface.sectionTitled,
        boxed && surface.sectionBoxed
      )}
    >
      {title || headerRight ? (
        <header {...stylex.props(surface.sectionHeader)}>
          <div {...stylex.props(surface.sectionHeading)}>
            {title ? (
              <p
                {...stylex.props(
                  surface.sectionTitle,
                  tone === 'danger' && surface.sectionTitleDanger
                )}
              >
                {title}
              </p>
            ) : null}
            {description ? (
              <p {...stylex.props(surface.sectionDescription)}>{description}</p>
            ) : null}
          </div>
          {headerRight ? <div {...stylex.props(surface.sectionAside)}>{headerRight}</div> : null}
          {actions ? (
            <div {...stylex.props(surface.sectionActions)}>
              {React.Children.map(actions, (child) => {
                if (
                  !React.isValidElement<{ size?: string; variant?: string; icon?: boolean }>(child)
                ) {
                  return child;
                }
                // A header action is a ghost icon button: it sits beside the
                // group's name, not on the card, so it takes no material.
                return React.cloneElement(child, {
                  size: child.props.size ?? 'small',
                  variant: child.props.variant ?? 'ghost',
                  icon: child.props.icon ?? true,
                });
              })}
            </div>
          ) : null}
        </header>
      ) : null}
      <div
        {...withClassName(
          stylex.props(
            boxed && settingsBoxed,
            surface.card,
            tone === 'danger' && surface.cardDanger
          ),
          className
        )}
      >
        {lines.map((line, index) => (
          <div
            key={React.isValidElement(line) && line.key != null ? line.key : index}
            {...stylex.props(surface.line, index > 0 && surface.lineRuled)}
          >
            {line}
          </div>
        ))}
      </div>
    </section>
  );
}

export function CompactRow({
  label,
  helper,
  children,
  className,
  alignTop = false,
  disabled = false,
}: CompactRowProps) {
  return (
    <div
      {...withClassName(stylex.props(surface.row, alignTop && surface.rowTop), className)}
      data-disabled={disabled ? '' : undefined}
    >
      {/* A bare label may use the whole column: long command names should not wrap early. */}
      <div {...stylex.props(surface.rowText, helper != null && surface.rowTextCapped)}>
        <p {...stylex.props(surface.rowLabel, disabled && surface.rowLabelDisabled)}>{label}</p>
        {helper ? <p {...stylex.props(surface.rowHelper)}>{helper}</p> : null}
      </div>
      {children ? (
        <div {...stylex.props(surface.rowControl, alignTop && surface.rowControlTop)}>
          {children}
        </div>
      ) : null}
    </div>
  );
}

interface CompactLinkRowProps extends Omit<ComponentProps<'button'>, 'className' | 'children'> {
  label: string;
  helper?: ReactNode;
  /** Where the row leads: out of Lody (`external`) or into a dialog (`open`). */
  to?: 'external' | 'open';
}

/**
 * A row that is itself the link: its name on the left, and at its end a quiet
 * mark for where it leads — a page outside Lody or a dialog. It carries no
 * button, so the row never says its name twice ("Website · Visit website").
 * A dialog trigger may render it (`render={<CompactLinkRow …/>}`).
 */
export const CompactLinkRow = forwardRef<HTMLButtonElement, CompactLinkRowProps>(
  function CompactLinkRow({ label, helper, to = 'external', type = 'button', ...rest }, ref) {
    const Mark = to === 'external' ? ArrowUpRight : ChevronRight;
    return (
      <button
        ref={ref}
        type={type}
        {...rest}
        {...stylex.props(surface.row, surface.pressableLine, surface.linkRow)}
      >
        <div {...stylex.props(surface.rowText, helper != null && surface.rowTextCapped)}>
          <p {...stylex.props(surface.rowLabel)}>{label}</p>
          {helper ? <p {...stylex.props(surface.rowHelper)}>{helper}</p> : null}
        </div>
        <span {...stylex.props(surface.rowControl, surface.linkEnd)}>
          <Mark {...stylex.props(surface.linkMark)} aria-hidden="true" />
        </span>
      </button>
    );
  }
);

/**
 * An empty catalog, in its list's own geometry: the records card it will
 * hold, with one quiet line where the records will be. No centred icon and no
 * second copy of the page's add action; `action` is for the one list whose way
 * in is not the page's add (installing the GitHub App).
 */
export function SettingsEmptyList({
  children,
  action,
}: {
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div {...stylex.props(settingsRecordsCard)}>
      {action ? (
        <div {...stylex.props(surface.cardNote, surface.cardNoteWithAction)}>
          <span>{children}</span>
          {action}
        </div>
      ) : (
        <p {...stylex.props(surface.cardNote)}>{children}</p>
      )}
    </div>
  );
}

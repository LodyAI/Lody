import React, { type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { withClassName } from '@/lib/stylex';
import { settingsSurface as surface } from './surface';

/**
 * The settings card for a standalone catalog row (MCP server, Agent role,
 * provider): the same card a section draws. Spread it with `stylex.props` so a
 * caller's layout classes compose rather than restating the material.
 */
export const settingsCard = surface.card;

interface CompactSectionProps {
  title?: string;
  description?: string;
  actions?: ReactNode;
  /** Free-form content on the right of the header (rendered as-is, unlike
   * `actions` which are coerced into icon buttons). */
  headerRight?: ReactNode;
  /** A group that destroys something — leave, transfer, delete — says so on its card. */
  tone?: 'default' | 'danger';
  children: ReactNode;
  className?: string;
}

interface CompactRowProps {
  label: string;
  helper?: ReactNode;
  children?: ReactNode;
  className?: string;
  alignTop?: boolean;
}

export function CompactSection({
  title,
  description,
  actions,
  headerRight,
  tone = 'default',
  children,
  className,
}: CompactSectionProps) {
  // The section owns the lines between its rows, so every child is one line of
  // the card whether or not it is a `CompactRow`.
  const lines = React.Children.toArray(children);
  return (
    <section {...stylex.props(surface.section)}>
      {title || headerRight ? (
        <header {...stylex.props(surface.sectionHeader)}>
          <div {...stylex.props(surface.sectionHeading)}>
            {title ? <p {...stylex.props(surface.sectionTitle)}>{title}</p> : null}
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
          stylex.props(surface.card, tone === 'danger' && surface.cardDanger),
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
}: CompactRowProps) {
  return (
    <div {...withClassName(stylex.props(surface.row, alignTop && surface.rowTop), className)}>
      {/* A bare label may use the whole column: long command names should not wrap early. */}
      <div {...stylex.props(surface.rowText, helper != null && surface.rowTextCapped)}>
        <p {...stylex.props(surface.rowLabel)}>{label}</p>
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

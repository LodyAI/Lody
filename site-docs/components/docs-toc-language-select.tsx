'use client';

import * as stylex from '@stylexjs/stylex';
import { Popover } from '@base-ui/react/popover';
import { useI18n } from 'fumadocs-ui/contexts/i18n';
import { ChevronDown, Languages } from 'lucide-react';

const enter = stylex.keyframes({ from: { opacity: 0, transform: 'scale(0.9)' } });
const leave = stylex.keyframes({ to: { opacity: 0, transform: 'scale(0.9)' } });

const styles = stylex.create({
  wrapper: { marginBottom: 'calc(var(--spacing) * 4)' },
  trigger: {
    display: 'inline-flex',
    alignItems: 'center',
    paddingBlock: 'calc(var(--spacing) * 1.5)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--color-fd-border)',
    fontWeight: 'var(--font-weight-medium, 500)',
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    transitionDuration: '100ms',
    transitionTimingFunction: 'var(--default-transition-timing-function)',
    outlineStyle: { default: null, ':focus-visible': 'none' },
    boxShadow: { default: null, ':focus-visible': '0 0 0 2px var(--color-fd-ring)' },
    opacity: { default: 1, ':disabled': 0.5 },
    pointerEvents: { default: 'auto', ':disabled': 'none' },
    height: 'calc(var(--spacing) * 9)',
    width: '100%',
    justifyContent: 'flex-start',
    gap: 'calc(var(--spacing) * 2)',
    borderRadius: 'var(--radius-lg)',
    backgroundColor: {
      default: 'color-mix(in oklab, var(--color-fd-secondary) 60%, transparent)',
      '@media (hover: hover)': { ':hover': 'var(--color-fd-accent)' },
    },
    paddingInline: 'calc(var(--spacing) * 2.5)',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
    color: {
      default: 'var(--color-fd-muted-foreground)',
      '@media (hover: hover)': { ':hover': 'var(--color-fd-accent-foreground)' },
    },
  },
  positioner: { zIndex: 50 },
  popup: {
    zIndex: 50,
    transformOrigin: 'var(--transform-origin)',
    overflowY: 'auto',
    maxHeight: 'var(--available-height)',
    minWidth: 240,
    maxWidth: '98vw',
    borderRadius: 'var(--radius-xl, 0.75rem)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--color-fd-border)',
    backgroundColor: 'color-mix(in oklab, var(--color-fd-popover) 60%, transparent)',
    backdropFilter: 'blur(var(--blur-lg, 16px))',
    padding: 'calc(var(--spacing) * 1)',
    fontSize: 'var(--text-sm, 0.875rem)',
    lineHeight: 'var(--text-sm--line-height, calc(1.25 / 0.875))',
    color: 'var(--color-fd-popover-foreground)',
    boxShadow: '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, var(--shadow-lg)',
    outlineStyle: { default: null, ':focus-visible': 'none' },
    display: 'flex',
    flexDirection: 'column',
    gap: 'calc(var(--spacing) * 0.5)',
    animationName: { default: 'none', ':is([data-open])': enter, ':is([data-closed])': leave },
    animationDuration: '100ms',
    animationTimingFunction: 'ease',
  },
  groupLabel: {
    padding: 'calc(var(--spacing) * 2)',
    fontSize: 'var(--text-xs, 0.75rem)',
    lineHeight: 'var(--text-xs--line-height, calc(1 / 0.75))',
    fontWeight: 'var(--font-weight-medium, 500)',
    color: 'var(--color-fd-muted-foreground)',
  },
  option: {
    paddingInline: 'calc(var(--spacing) * 2)',
    paddingBlock: 'calc(var(--spacing) * 1.5)',
    textAlign: 'start',
    fontSize: 'var(--text-sm, 0.875rem)',
    lineHeight: 'var(--text-sm--line-height, calc(1.25 / 0.875))',
    borderRadius: 'var(--radius-lg)',
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    transitionDuration: 'var(--default-transition-duration, 150ms)',
    transitionTimingFunction: 'var(--default-transition-timing-function)',
  },
  selectedOption: {
    backgroundColor: 'color-mix(in oklab, var(--color-fd-primary) 10%, transparent)',
    color: 'var(--color-fd-primary)',
  },
  availableOption: {
    color: {
      default: 'var(--color-fd-muted-foreground)',
      '@media (hover: hover)': { ':hover': 'var(--color-fd-accent-foreground)' },
    },
    backgroundColor: {
      default: 'transparent',
      '@media (hover: hover)': { ':hover': 'var(--color-fd-accent)' },
    },
  },
  languageIcon: { width: 'calc(var(--spacing) * 4)', height: 'calc(var(--spacing) * 4)' },
  label: {
    minWidth: 0,
    flex: '1',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    textAlign: 'start',
  },
  chevron: {
    marginInlineStart: 'auto',
    width: 'calc(var(--spacing) * 3.5)',
    height: 'calc(var(--spacing) * 3.5)',
    opacity: 0.7,
  },
});

export function DocsTocLanguageSelect() {
  const context = useI18n();
  if (!context.locales) throw new Error('Missing <I18nProvider />');
  const label = context.locales.find((item) => item.locale === context.locale)?.name;

  return (
    <div {...stylex.props(styles.wrapper)}>
      <Popover.Root>
        <Popover.Trigger aria-label={context.text.chooseLanguage} {...stylex.props(styles.trigger)}>
          <Languages aria-hidden="true" {...stylex.props(styles.languageIcon)} />
          <span {...stylex.props(styles.label)}>{label}</span>
          <ChevronDown aria-hidden="true" {...stylex.props(styles.chevron)} />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner
            align="center"
            side="bottom"
            sideOffset={4}
            {...stylex.props(styles.positioner)}
          >
            <Popover.Popup {...stylex.props(styles.popup)}>
              <p {...stylex.props(styles.groupLabel)}>{context.text.chooseLanguage}</p>
              {context.locales.map((item) => (
                <button
                  key={item.locale}
                  type="button"
                  {...stylex.props(
                    styles.option,
                    item.locale === context.locale ? styles.selectedOption : styles.availableOption
                  )}
                  onClick={() => context.onChange?.(item.locale)}
                >
                  {item.name}
                </button>
              ))}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

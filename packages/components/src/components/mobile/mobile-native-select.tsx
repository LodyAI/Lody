/**
 * Native-select control for compact mobile target rows.
 *
 * Adapted from the community contribution in
 * [#491](https://github.com/LodyAI/Lody/pull/491) by @natsustan. The visual
 * trigger is branded; the invisible real `<select>` lets every touch platform
 * present its own option picker instead of an app-owned menu.
 */
import { ChevronsUpDown } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';

import * as stylex from '@stylexjs/stylex';
import { clsx } from 'clsx';
import { Spinner } from '@lody/ui/spinner';
import { field } from '@lody/ui/field/field.tokens.stylex';
import { control, text } from '@lody/ui/tokens/scales.stylex';

export type MobileNativeSelectOption<T extends string = string> = {
  value: T;
  label: string;
  group?: string;
  disabled?: boolean;
};

export type MobileNativeSelectProps<T extends string = string> = {
  value: T | null | undefined;
  onChange: (value: T) => void;
  options: MobileNativeSelectOption<T>[];
  triggerContent: ReactNode;
  ariaLabel: string;
  disabled?: boolean;
  loading?: boolean;
  loadingText?: ReactNode;
  showIndicator?: boolean;
  className?: string;
  xstyle?: stylex.StyleXStyles;
};

/**
 * A visually branded trigger backed by a real HTML select. Touch platforms
 * therefore present their system option picker instead of an app-owned menu.
 */
export function MobileNativeSelect<T extends string = string>({
  value,
  onChange,
  options,
  triggerContent,
  ariaLabel,
  disabled = false,
  loading = false,
  loadingText,
  showIndicator = true,
  className,
  xstyle,
}: MobileNativeSelectProps<T>) {
  const hasAlternative = options.some((option) => !option.disabled && option.value !== value);
  const isInteractive = !disabled && !loading && hasAlternative;
  const groupedOptions = options.reduce<
    Array<{ label: string | null; options: MobileNativeSelectOption<T>[] }>
  >((groups, option) => {
    const label = option.group ?? null;
    const existing = groups.find((group) => group.label === label);
    if (existing) {
      existing.options.push(option);
    } else {
      groups.push({ label, options: [option] });
    }
    return groups;
  }, []);

  const rootProps = stylex.props(styles.root, (disabled || loading) && styles.disabled, xstyle);
  return (
    <div {...rootProps} className={clsx(rootProps.className, className)}>
      <span {...stylex.props(styles.value)}>
        {loading ? (
          <>
            <Spinner diameter="14px" label={null} />
            {loadingText ?? triggerContent}
          </>
        ) : (
          triggerContent
        )}
      </span>
      {isInteractive && showIndicator ? (
        <ChevronsUpDown {...stylex.props(styles.chevron)} aria-hidden="true" />
      ) : null}
      <select
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value as T)}
        disabled={!isInteractive}
        aria-label={ariaLabel}
        {...stylex.props(styles.select, isInteractive ? styles.interactive : styles.inert)}
      >
        <option value="" disabled>
          {ariaLabel}
        </option>
        {groupedOptions.map((group) => {
          const optionNodes = group.options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ));
          return group.label ? (
            <optgroup key={group.label} label={group.label}>
              {optionNodes}
            </optgroup>
          ) : (
            <Fragment key="ungrouped">{optionNodes}</Fragment>
          );
        })}
      </select>
    </div>
  );
}

const styles = stylex.create({
  root: {
    position: 'relative',
    display: 'flex',
    height: '32px',
    width: '100%',
    userSelect: 'none',
    alignItems: 'center',
    gap: '6px',
    borderRadius: field.radiusMedium,
    paddingInline: '8px',
    paddingBlock: '4px',
    textAlign: 'left',
    fontSize: field.text,
    lineHeight: text.subheadlineLeading,
    fontWeight: 500,
    letterSpacing: text.controlTracking,
    color: field.value,
    backgroundColor: field.background,
    boxShadow: {
      default: field.well,
      ':focus-within': `0 0 0 ${field.ringWidth} ${field.ring}, ${field.well}`,
    },
  },
  disabled: { opacity: control.disabledOpacity },
  value: { display: 'flex', minWidth: 0, flex: '1 1 0%', alignItems: 'center', gap: '8px' },
  chevron: { width: '16px', height: '16px', flexShrink: 0, color: field.icon },
  select: {
    position: 'absolute',
    inset: 0,
    height: '100%',
    width: '100%',
    appearance: 'none',
    opacity: 0,
    outlineStyle: 'none',
  },
  interactive: { cursor: 'pointer' },
  inert: { cursor: 'default' },
});

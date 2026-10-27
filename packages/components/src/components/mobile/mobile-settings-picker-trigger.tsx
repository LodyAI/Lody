import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';

// The theme tokens are imported by path, not by the `@/` alias: the StyleX
// compiler links a theme file on its own and does not follow bundler aliases.
import { themeSpace } from '../../style/theme-scale.stylex';
import {
  MobileInlinePicker,
  type MobileInlinePickerOption,
} from '@/components/mobile/mobile-inline-picker';

const styles = stylex.create({
  /** The trigger's box: it hugs its label and never takes the whole row. */
  trigger: { display: 'inline-block', maxWidth: '60vw' },
  /** The icon slot beside the label. */
  iconSlot: { flexShrink: 0 },
  /** The label: it truncates and keeps the row on one line. */
  label: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    textAlign: 'right',
  },
  /** The chevron that says the trigger opens a list. */
  chevron: {
    height: themeSpace[3.5],
    width: themeSpace[3.5],
    flexShrink: 0,
    opacity: 0.6,
  },
});

export function MobileSettingsPickerTrigger<T extends string>({
  id,
  ariaLabel,
  value,
  options,
  onChange,
  triggerLabel,
  triggerIcon,
  searchable,
  searchPlaceholder,
}: {
  id: string;
  ariaLabel: string;
  value: T;
  options: MobileInlinePickerOption<T>[];
  onChange: (next: T) => void;
  triggerLabel: ReactNode;
  triggerIcon?: ReactNode;
  searchable?: boolean;
  searchPlaceholder?: string;
}) {
  return (
    <div {...stylex.props(styles.trigger)}>
      <MobileInlinePicker<T>
        id={id}
        value={value}
        onChange={onChange}
        options={options}
        ariaLabel={ariaLabel}
        searchable={searchable}
        searchPlaceholder={searchPlaceholder}
        triggerClassName="w-auto"
        triggerContent={
          <>
            {triggerIcon ? <span {...stylex.props(styles.iconSlot)}>{triggerIcon}</span> : null}
            <span {...stylex.props(styles.label)}>{triggerLabel}</span>
            <ChevronDown {...stylex.props(styles.chevron)} strokeWidth={2} aria-hidden="true" />
          </>
        }
      />
    </div>
  );
}

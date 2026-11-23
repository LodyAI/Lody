import { useRef, type ReactNode } from 'react';
import { Select } from '@lody/ui/select';

export interface PreviewSelectOption<T extends string> {
  value: T;
  label: ReactNode;
}

interface PreviewSelectProps<T extends string> {
  value: T;
  options: PreviewSelectOption<T>[];
  /** Live-preview the highlighted value. Omit when the option has no live preview. */
  onPreview?: (value: T) => void;
  onCommit: (value: T) => void;
  /** Restore the original value when the list closes without a pick. */
  onCancel?: () => void;
  triggerClassName?: string;
  'aria-label'?: string;
}

/**
 * A `@lody/ui` Select whose highlighted row can be previewed before it is picked
 * — a theme shown on the settings behind the list while the pointer or the arrow
 * keys move down it.
 *
 * It was a hand-built popover with its own trigger, rows and key handling, which
 * is why it looked like no other select in the product. Base UI moves focus onto
 * the highlighted row, so a row taking focus is the preview; a pick commits it,
 * and a list closed without one hands the original back through `onCancel`.
 */
export function PreviewSelect<T extends string>({
  value,
  options,
  onPreview,
  onCommit,
  onCancel,
  triggerClassName,
  'aria-label': ariaLabel,
}: PreviewSelectProps<T>) {
  const committedRef = useRef(false);

  return (
    <Select.Root
      items={options}
      value={value}
      onOpenChange={(open) => {
        if (open) committedRef.current = false;
        else if (!committedRef.current) onCancel?.();
      }}
      onValueChange={(next) => {
        if (next == null) return;
        committedRef.current = true;
        onCommit(next as T);
      }}
    >
      <Select.Trigger className={triggerClassName} aria-label={ariaLabel}>
        <Select.Value />
      </Select.Trigger>
      <Select.Content>
        {options.map((option) => (
          <Select.Item
            key={option.value}
            value={option.value}
            onFocus={onPreview ? () => onPreview(option.value) : undefined}
          >
            {option.label}
          </Select.Item>
        ))}
      </Select.Content>
    </Select.Root>
  );
}

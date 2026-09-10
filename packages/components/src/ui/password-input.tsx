import * as React from 'react';
import { Eye, EyeOff } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Input, type InputProps } from '@lody/ui/input';

// Props follow the wrapped primitive, not a raw `<input>`: `size` on `Input` is
// the token step, so taking the HTML attribute here would shadow it.
export interface PasswordInputProps extends Omit<InputProps, 'type'> {
  showPasswordLabel?: string;
  hidePasswordLabel?: string;
  containerClassName?: string;
}

const PasswordInput = React.forwardRef<HTMLInputElement, PasswordInputProps>(
  (
    {
      className,
      containerClassName,
      disabled,
      showPasswordLabel = 'Show password',
      hidePasswordLabel = 'Hide password',
      ...props
    },
    ref
  ) => {
    const [visible, setVisible] = React.useState(false);
    const Icon = visible ? EyeOff : Eye;
    return (
      <div className={cn('relative', containerClassName)}>
        <Input
          ref={ref}
          type={visible ? 'text' : 'password'}
          disabled={disabled}
          className={cn('pr-10', className)}
          {...props}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          disabled={disabled}
          aria-label={visible ? hidePasswordLabel : showPasswordLabel}
          aria-pressed={visible}
          aria-controls={props.id}
          className={cn(
            'absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground transition-colors',
            'hover:text-foreground focus-visible:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring',
            'disabled:cursor-not-allowed disabled:opacity-50'
          )}
        >
          <Icon className="size-4" strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
    );
  }
);
PasswordInput.displayName = 'PasswordInput';

export { PasswordInput };

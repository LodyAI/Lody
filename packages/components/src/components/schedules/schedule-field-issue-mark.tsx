import { AlertCircle } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { Tooltip } from '@lody/ui/tooltip';
import { cn } from '@/lib/utils';

const styles = stylex.create({
  mark: {
    display: 'inline-flex',
    width: 'calc(var(--spacing) * 4)',
    height: 'calc(var(--spacing) * 4)',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 'calc(infinity * 1px)',
    color: 'hsl(var(--status-warning) / 1)',
  },
  icon: { width: 'calc(var(--spacing) * 3.5)', height: 'calc(var(--spacing) * 3.5)' },
  item: {
    marginBlockStart: { default: null, ':not(:last-child)': 0 },
    marginBlockEnd: { default: null, ':not(:last-child)': 'calc(var(--spacing) * 0.5)' },
  },
});

/**
 * The exclamation mark shown next to the control that fixes a save blocker.
 * The reason is its accessible name and its tooltip, so nothing is listed at
 * the bottom of the form.
 */
export function FieldIssueMark({
  messages,
  className,
}: {
  messages: readonly string[];
  className?: string;
}) {
  if (messages.length === 0) return null;
  const label = messages.join(' ');
  return (
    // Tooltips are visual-only in `@lody/ui`, so the mark names itself.
    <Tooltip.Root>
      <Tooltip.Trigger
        render={
          <span
            role="img"
            aria-label={label}
            tabIndex={0}
            className={cn(stylex.props(styles.mark).className, className)}
          >
            <AlertCircle {...stylex.props(styles.icon)} aria-hidden="true" />
          </span>
        }
      />
      <Tooltip.Content>
        {messages.length === 1 ? (
          messages[0]
        ) : (
          <ul>
            {messages.map((message) => (
              <li key={message} {...stylex.props(styles.item)}>
                {message}
              </li>
            ))}
          </ul>
        )}
      </Tooltip.Content>
    </Tooltip.Root>
  );
}

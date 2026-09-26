import { AlertCircle } from 'lucide-react';
import { Tooltip } from '@lody/ui/tooltip';
import { cn } from '@/lib/utils';

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
            className={cn(
              'inline-flex size-4 shrink-0 items-center justify-center rounded-full text-status-warning',
              className
            )}
          >
            <AlertCircle className="size-3.5" aria-hidden="true" />
          </span>
        }
      />
      <Tooltip.Content>
        {messages.length === 1 ? (
          messages[0]
        ) : (
          <ul className="space-y-0.5">
            {messages.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        )}
      </Tooltip.Content>
    </Tooltip.Root>
  );
}

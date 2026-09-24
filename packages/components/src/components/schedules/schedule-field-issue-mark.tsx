import { AlertCircle } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
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
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={label}
          tabIndex={0}
          className={cn(
            'inline-flex size-4 shrink-0 items-center justify-center rounded-full text-status-warning focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring',
            className
          )}
        >
          <AlertCircle className="size-3.5" aria-hidden="true" />
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">
        {messages.length === 1 ? (
          messages[0]
        ) : (
          <ul className="space-y-0.5">
            {messages.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

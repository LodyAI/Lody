import { MoreHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { SessionFileMenuItem } from '@/hooks/use-session-file-actions';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';

/**
 * The side panel's ⋯ button: the same actions the file tree offers on
 * right-click, for the file the panel is currently showing. It renders nothing
 * when the active tab is not a file — a "more" button with nothing behind it is
 * worse than no button.
 */
export function SessionFileActionsMenu({
  filePath,
  items,
  className,
}: {
  readonly filePath: string | null;
  readonly items: readonly SessionFileMenuItem[];
  readonly className?: string;
}) {
  const { t } = useTranslation();
  if (!filePath || items.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('sessions.fileActions.more', 'File actions')}
          className={cn(
            'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-hover-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/40',
            className
          )}
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[190px]">
        {items.map((item) => {
          const ItemIcon = item.icon;
          return (
            <DropdownMenuItem key={item.id} className="gap-2" onSelect={() => item.run(filePath)}>
              <ItemIcon className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="truncate">{item.label}</span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

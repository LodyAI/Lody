import type { CSSProperties, ReactNode } from 'react';
import { Menu } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { useIsMobile } from '../../hooks/use-mobile';
import { useSetAtom } from 'jotai';
import { toggleMobileDrawerAtom } from '../../atoms';
import { isNativeAppShell } from '@/lib/native-platform';
import { cn } from '@/lib/utils';

interface BaseHeaderProps {
  title: ReactNode;
  actions?: ReactNode;
  className?: string;
  /** Inline overrides (e.g. the mobile session floating header's exact height). */
  style?: CSSProperties;
  hideMenuButton?: boolean;
  leading?: ReactNode;
  truncateTitle?: boolean;
}

/**
 * Base header component.
 * Provides a responsive page header layout and shows a drawer toggle on mobile.
 */
export function BaseHeader({
  title,
  actions,
  className,
  style,
  hideMenuButton = false,
  leading,
  truncateTitle = true,
}: BaseHeaderProps) {
  const isMobile = useIsMobile();
  const isNativeApp = isNativeAppShell();
  const toggleDrawer = useSetAtom(toggleMobileDrawerAtom);

  return (
    <div
      className={cn(
        'flex items-center border-b border-border bg-background',
        isNativeApp
          ? 'h-[calc(3.5rem+var(--safe-area-top))] pt-[var(--safe-area-top)] pl-[calc(0.75rem+var(--safe-area-left))] pr-[calc(0.75rem+var(--safe-area-right))] sm:pl-[calc(1rem+var(--safe-area-left))] sm:pr-[calc(1rem+var(--safe-area-right))]'
          : 'h-14 px-3 sm:px-4',
        className
      )}
      style={style}
    >
      {/* Mobile: drawer toggle */}
      {isMobile && !hideMenuButton && (
        <Button
          variant="ghost"
          icon
          className="mr-2 md:hidden"
          onClick={(e) => {
            // Remove focus to avoid aria-hidden warnings in some browsers.
            (e.currentTarget as HTMLElement).blur();
            toggleDrawer();
          }}
        >
          <Menu className="h-5 w-5" />
        </Button>
      )}

      {/* Custom leading element (e.g. back button) */}
      {leading && <div className="mr-2 shrink-0">{leading}</div>}

      {/* Title */}
      <h2
        className={cn(
          'min-w-0 flex-1 text-xl font-semibold',
          isMobile && 'text-base',
          truncateTitle && 'truncate'
        )}
      >
        {title}
      </h2>

      {/* Actions */}
      {actions && <div className="ml-2 flex shrink-0 items-center gap-1 sm:gap-2">{actions}</div>}
    </div>
  );
}

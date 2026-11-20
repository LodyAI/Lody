import { type ReactNode, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Kbd } from '@lody/ui/kbd';
import { Tooltip } from '@lody/ui/tooltip';
import { cn } from '@/lib/utils';
import { commands, formatKeyBinding, type ShortcutCommandId } from '@/lib/commands';
import { CuidaSidebarExpandOutline } from './icons/cuida-sidebar-expand-outline';
import { sidebarSurface } from './sidebar-surface';

/**
 * The live binding for a command, formatted for this platform, or null when the
 * command is unbound (or not registered). Read from the registry rather than
 * `COMMAND_SHORTCUTS` so a rebound key is what the tooltip teaches.
 */
function useCommandShortcutLabel(id: ShortcutCommandId): string | null {
  const binding = useSyncExternalStore(
    (onChange) => commands.subscribe(onChange),
    // A string, not the array: `getKeybindingsFor` allocates, and an unstable
    // snapshot would re-render forever.
    () => commands.getKeybindingsFor(id)[0] ?? '',
    () => ''
  );
  return binding ? formatKeyBinding(binding) : null;
}

type NavigationAvailability = {
  canGoBack: boolean;
  canGoForward: boolean;
};

type WindowNavigation = {
  canGoBack: boolean;
  canGoForward: boolean;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
};

const readNavigationAvailability = (): NavigationAvailability => {
  const navigation = (window as Window & { navigation?: WindowNavigation }).navigation;
  if (navigation && typeof navigation.canGoBack === 'boolean') {
    return { canGoBack: navigation.canGoBack, canGoForward: navigation.canGoForward };
  }
  return {
    canGoBack: window.history.length > 1,
    canGoForward: false,
  };
};

let navigationAvailabilitySnapshot: NavigationAvailability = {
  canGoBack: false,
  canGoForward: false,
};

const getNavigationAvailabilitySnapshot = (): NavigationAvailability => {
  const next = readNavigationAvailability();
  if (
    next.canGoBack === navigationAvailabilitySnapshot.canGoBack &&
    next.canGoForward === navigationAvailabilitySnapshot.canGoForward
  ) {
    return navigationAvailabilitySnapshot;
  }
  navigationAvailabilitySnapshot = next;
  return next;
};

const subscribeNavigationAvailability = (onStoreChange: () => void) => {
  window.addEventListener('popstate', onStoreChange);
  const navigation = (window as Window & { navigation?: WindowNavigation }).navigation;
  navigation?.addEventListener('currententrychange', onStoreChange);
  navigation?.addEventListener('navigate', onStoreChange);
  return () => {
    window.removeEventListener('popstate', onStoreChange);
    navigation?.removeEventListener('currententrychange', onStoreChange);
    navigation?.removeEventListener('navigate', onStoreChange);
  };
};

export function useNavigationAvailability(): NavigationAvailability {
  return useSyncExternalStore(
    subscribeNavigationAvailability,
    getNavigationAvailabilitySnapshot,
    () => navigationAvailabilitySnapshot
  );
}

function SidebarHeaderIconButton({
  label,
  shortcut,
  onClick,
  className,
  disabled = false,
  children,
}: {
  label: string;
  shortcut?: string | null;
  onClick?: () => void;
  className?: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  const button = (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        // The same box, ink and fills as the footer's icon buttons.
        stylex.props(sidebarSurface.iconButton).className,
        'outline-hidden transition-colors',
        disabled
          ? // pointer-events-none keeps the hover fill off a control that cannot act.
            // 60% keeps a disabled Back or Forward legible as "unavailable"
            // rather than missing.
            'pointer-events-none cursor-default text-sidebar-foreground-muted/60'
          : 'focus-visible:ring-1 focus-visible:ring-sidebar-ring/40',
        className
      )}
    >
      {children}
    </button>
  );
  if (disabled) return button;
  return (
    <Tooltip.Root>
      <Tooltip.Trigger render={button} />
      <Tooltip.Content side="bottom" className="flex items-center gap-1.5">
        <span>{label}</span>
        {shortcut ? <Kbd>{shortcut}</Kbd> : null}
      </Tooltip.Content>
    </Tooltip.Root>
  );
}

/**
 * Toggle Sidebar, Back and Forward. The sidebar header renders them; a page
 * header renders the same controls while the navigation sidebar is hidden, so
 * they never disappear with it. Callers inside a window drag region pass
 * `WINDOW_DRAG_EXEMPT_CLASS` through `className`.
 */
export function SidebarHistoryControls({
  onToggleSidebar,
  className,
}: {
  onToggleSidebar?: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const toggleShortcut = useCommandShortcutLabel('sidebar.toggle');
  const backShortcut = useCommandShortcutLabel('nav.back');
  const forwardShortcut = useCommandShortcutLabel('nav.forward');
  const { canGoBack, canGoForward } = useNavigationAvailability();
  return (
    <Tooltip.Provider delay={400}>
      <div
        className={cn(
          // `gap-0.5` between full-size buttons keeps Back and Forward
          // apart as two targets instead of one fused control.
          'flex shrink-0 items-center gap-0.5',
          className
        )}
      >
        {onToggleSidebar ? (
          <SidebarHeaderIconButton
            label={t('commands.sidebar.toggle', 'Toggle Sidebar')}
            shortcut={toggleShortcut}
            onClick={() => onToggleSidebar()}
            // Always visible: the collapse control is found where it
            // was last seen, not revealed by hovering the header.
            className="focus-visible:outline-hidden"
          >
            <CuidaSidebarExpandOutline className="h-4 w-4" />
          </SidebarHeaderIconButton>
        ) : null}
        <SidebarHeaderIconButton
          disabled={!canGoBack}
          label={t('commands.nav.back', 'Back')}
          shortcut={backShortcut}
          onClick={() => {
            if (!canGoBack) return;
            if (!commands.execute('nav.back')) window.history.back();
          }}
        >
          <ChevronLeft className="h-4 w-4" strokeWidth={1.5} />
        </SidebarHeaderIconButton>
        <SidebarHeaderIconButton
          disabled={!canGoForward}
          label={t('commands.nav.forward', 'Forward')}
          shortcut={forwardShortcut}
          onClick={() => {
            if (!canGoForward) return;
            if (!commands.execute('nav.forward')) window.history.forward();
          }}
        >
          <ChevronRight className="h-4 w-4" strokeWidth={1.5} />
        </SidebarHeaderIconButton>
      </div>
    </Tooltip.Provider>
  );
}

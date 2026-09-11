import { useCallback, useEffect, useRef, useState } from 'react';
import { FolderOpen, FolderPlus, Github, MessageCircle } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger } from '@/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import { cn } from '@/lib/utils';
import type { ChatLandingTone } from './chat-landing-view';

export type SessionContextType = 'local' | 'github' | 'chat';

export interface DisabledTabOverlay {
  /** Content shown on hover overlay or tooltip */
  label: React.ReactNode;
  /** Callback when clicked. If provided, shows hover overlay; otherwise shows tooltip. */
  onClick?: () => void;
}

interface ContextSwitchProps {
  value: SessionContextType;
  onChange: (value: SessionContextType) => void;
  tone: ChatLandingTone;
  localLabel?: string;
  githubLabel?: string;
  chatLabel?: string;
  /** When set, the local tab is disabled */
  localDisabled?: DisabledTabOverlay;
  /** When set, the github tab is disabled */
  githubDisabled?: DisabledTabOverlay;
  className?: string;
  /** Optional sizing override for the segmented-control track. */
  tabsListClassName?: string;
  /** Optional sizing override for each segmented-control item. */
  tabsTriggerClassName?: string;
  /** Override the per-trigger justify class. Defaults to `justify-center`
     so icon+label sit as a tight centered group inside each equal-width pill. */
  triggerJustifyClassName?: string;
}

/** Icon + label bonded as one unit so justify-* positions the pair together
 *  rather than stretching them apart (which broke affinity on the mobile
 *  new-chat Type row). */
function TabFace({ icon, label }: { icon: React.ReactNode; label: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1">
      {icon}
      <span>{label}</span>
    </span>
  );
}

export function ContextSwitch({
  value,
  onChange,
  tone,
  localLabel = 'Local',
  githubLabel = 'GitHub',
  chatLabel = 'Chat',
  localDisabled,
  githubDisabled,
  className,
  tabsListClassName,
  tabsTriggerClassName,
  triggerJustifyClassName = 'justify-center',
}: ContextSwitchProps) {
  const isDark = tone === 'dark';
  const iconClassName = 'h-3.5 w-3.5 shrink-0';

  const triggerClassName = cn(
    'flex-1 rounded-md px-2 sm:px-3 py-1.5 text-sm font-medium transition-all',
    triggerJustifyClassName,
    isDark
      ? 'data-[state=active]:bg-background/95 data-[state=active]:text-foreground data-[state=active]:shadow-xs text-muted-foreground hover:text-foreground'
      : 'data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-xs text-muted-foreground',
    tabsTriggerClassName
  );

  return (
    <Tabs
      value={value}
      onValueChange={(v) => onChange(v as SessionContextType)}
      className={cn('w-full max-w-xs sm:max-w-sm', className)}
    >
      <TabsList
        className={cn(
          'flex h-10 w-full rounded-lg p-1',
          isDark ? 'bg-card/70 border border-border/70' : 'bg-muted border border-border/40',
          tabsListClassName
        )}
      >
        {localDisabled ? (
          <DisabledTab
            icon={<FolderOpen className={iconClassName} />}
            label={localLabel}
            overlay={localDisabled}
            overlayIcon={<FolderPlus className="h-3.5 w-3.5" />}
            className={triggerClassName}
            tone={tone}
          />
        ) : (
          <TabsTrigger value="local" className={triggerClassName}>
            <TabFace icon={<FolderOpen className={iconClassName} />} label={localLabel} />
          </TabsTrigger>
        )}
        {githubDisabled ? (
          <DisabledTab
            icon={<Github className={iconClassName} />}
            label={githubLabel}
            overlay={githubDisabled}
            overlayIcon={<Github className="h-3.5 w-3.5" />}
            className={triggerClassName}
            tone={tone}
          />
        ) : (
          <TabsTrigger value="github" className={triggerClassName}>
            <TabFace icon={<Github className={iconClassName} />} label={githubLabel} />
          </TabsTrigger>
        )}
        <TabsTrigger value="chat" className={triggerClassName}>
          <TabFace icon={<MessageCircle className={iconClassName} />} label={chatLabel} />
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

function DisabledTab({
  icon,
  label,
  overlay,
  overlayIcon,
  className,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  overlay: DisabledTabOverlay;
  overlayIcon: React.ReactNode;
  className?: string;
  tone: ChatLandingTone;
}) {
  const isDark = tone === 'dark';

  // Tooltip mode: non-Electron "Desktop only" — no actionable overlay
  // Use controlled open state so mobile tap keeps tooltip visible until user taps elsewhere.
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const handleClick = useCallback(() => {
    setTooltipOpen((prev) => !prev);
  }, []);

  const handlePointerLeave = useCallback(() => {
    window.setTimeout(() => {
      const triggerHovered = triggerRef.current?.matches(':hover');
      const contentHovered = contentRef.current?.matches(':hover');
      if (triggerHovered || contentHovered) return;
      setTooltipOpen(false);
    }, 0);
  }, []);

  // Close tooltip when clicking outside
  useEffect(() => {
    if (!tooltipOpen) return undefined;
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (contentRef.current?.contains(target)) return;
      setTooltipOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [tooltipOpen]);

  if (!overlay.onClick) {
    return (
      <Tooltip open={tooltipOpen} delayDuration={200}>
        <TooltipTrigger asChild>
          <button
            ref={triggerRef}
            type="button"
            onClick={handleClick}
            onPointerEnter={() => setTooltipOpen(true)}
            onPointerLeave={handlePointerLeave}
            className={cn(
              className,
              'inline-flex flex-1 cursor-default items-center justify-center whitespace-nowrap opacity-40'
            )}
          >
            <TabFace icon={icon} label={label} />
          </button>
        </TooltipTrigger>
        <TooltipContent
          ref={contentRef}
          side="bottom"
          sideOffset={8}
          onPointerEnter={() => setTooltipOpen(true)}
          onPointerLeave={handlePointerLeave}
        >
          {overlay.label}
        </TooltipContent>
      </Tooltip>
    );
  }

  // Overlay mode: hover shows action text over the button
  return (
    <button
      type="button"
      onClick={overlay.onClick}
      className={cn(
        className,
        'group relative inline-flex flex-1 cursor-pointer items-center justify-center whitespace-nowrap',
        'opacity-40 transition-opacity hover:opacity-80'
      )}
    >
      <span className="transition-opacity group-hover:opacity-0">
        <TabFace icon={icon} label={label} />
      </span>
      <span
        className={cn(
          'absolute inset-0 inline-flex items-center justify-center gap-1 rounded-md',
          'opacity-0 transition-opacity group-hover:opacity-100',
          isDark ? 'bg-hover/90 text-hover-foreground' : 'bg-muted/90 text-foreground'
        )}
      >
        {overlayIcon}
        <span>{overlay.label}</span>
      </span>
    </button>
  );
}

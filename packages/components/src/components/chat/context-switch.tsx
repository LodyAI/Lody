import { useCallback, useEffect, useRef, useState } from 'react';
import { FolderOpen, FolderPlus, Github, MessageCircle } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { Tabs } from '@lody/ui/tabs';
import { disclosure } from '@lody/ui/disclosure/disclosure.tokens.stylex';
import { Tooltip } from '@lody/ui/tooltip';
import { cn } from '@/lib/utils';
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeDuration,
  themeEasing,
  themeFontSize,
  themeFontWeight,
  themeLineHeight,
  themeRadius,
  themeSpace,
} from '../../style/theme-scale.stylex';
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
  /** Override the per-trigger justify class. Defaults to `justify-center`
     so icon+label sit as a tight centered group inside each equal-width pill. */
  triggerJustifyClassName?: string;
}

const styles = stylex.create({
  tabTypography: {
    [disclosure.tabPaddingX]: {
      default: 'calc(var(--spacing) * 2)',
      '@media (width >= 40rem)': 'calc(var(--spacing) * 3)',
    },
    [disclosure.tabText]: 'var(--text-sm)',
    lineHeight: 'var(--tw-leading, var(--text-sm--line-height))',
  },
  disabledTab: {
    display: 'inline-flex',
    flex: '1 1 0%',
    alignItems: 'center',
    justifyContent: 'center',
    whiteSpace: 'nowrap',
    borderRadius: themeRadius.md,
    paddingInline: { default: themeSpace[2], '@media (min-width: 640px)': themeSpace[3] },
    paddingBlock: themeSpace[1.5],
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    fontWeight: themeFontWeight.medium,
    color: themeColors.mutedForeground,
    opacity: 0.4,
    transitionProperty: 'all',
    transitionDuration: themeDuration[150],
    transitionTimingFunction: themeEasing['in-out'],
  },
  disabledTabDark: {
    color: {
      default: themeColors.mutedForeground,
      '@media (hover: hover)': { ':hover': themeColors.foreground },
    },
  },
  tooltipTab: { cursor: 'default' },
  actionTab: {
    position: 'relative',
    cursor: 'pointer',
    opacity: { default: 0.4, '@media (hover: hover)': { ':hover': 0.8 } },
    transitionProperty: 'opacity',
  },
  /** Icon + label bonded as one unit so justify-* positions the pair together
   *  rather than stretching them apart (which broke affinity on the mobile
   *  new-chat Type row). */
  face: { display: 'inline-flex', alignItems: 'center', gap: themeSpace[1] },
  icon: { width: themeSpace[3.5], height: themeSpace[3.5], flexShrink: 0 },
  /** The overlay's own mark: it is not a flex item that may shrink. */
  overlayIcon: { width: themeSpace[3.5], height: themeSpace[3.5] },
  /** The overlay that replaces a disabled tab's face while the pointer is on it. */
  overlay: {
    position: 'absolute',
    inset: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: themeSpace[1],
    borderRadius: themeRadius.md,
    opacity: {
      default: 0,
      '@media (hover: hover)': {
        [stylex.when.ancestor(':is([data-context-disabled-action]):hover')]: 1,
      },
    },
    transitionProperty: 'opacity',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
  overlayDark: {
    backgroundColor: 'hsl(var(--hover) / 0.9)',
    color: themeColors.hoverForeground,
  },
  overlayLight: {
    backgroundColor: 'hsl(var(--muted) / 0.9)',
    color: themeColors.foreground,
  },
  /** The face that fades out under the overlay. */
  faceFade: {
    opacity: {
      default: 1,
      '@media (hover: hover)': {
        [stylex.when.ancestor(':is([data-context-disabled-action]):hover')]: 0,
      },
    },
    transitionProperty: 'opacity',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
});

/** Icon + label bonded as one unit so justify-* positions the pair together
 *  rather than stretching them apart (which broke affinity on the mobile
 *  new-chat Type row). */
function TabFace({ icon, label }: { icon: React.ReactNode; label: React.ReactNode }) {
  return (
    <span {...stylex.props(styles.face)}>
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
  triggerJustifyClassName = 'justify-center',
}: ContextSwitchProps) {
  const isDark = tone === 'dark';
  const iconClassName = stylex.props(styles.icon).className;
  const overlayIconClassName = stylex.props(styles.overlayIcon).className;

  // Padding and text size use the tab's existing tokens. The remaining
  // physical/state classes preserve their precedence over the primitive.
  const triggerClassName = cn(
    stylex.props(styles.tabTypography).className,
    'flex-1 rounded-md py-1.5 font-medium transition-all',
    triggerJustifyClassName,
    isDark
      ? 'data-[state=active]:bg-background/95 data-[state=active]:text-foreground data-[state=active]:shadow-xs text-muted-foreground hover:text-foreground'
      : 'data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-xs text-muted-foreground'
  );

  return (
    <Tabs.Root
      value={value}
      onValueChange={(v) => onChange(v as SessionContextType)}
      className={cn('w-full max-w-xs sm:max-w-sm', className)}
    >
      <Tabs.List
        className={cn(
          'flex h-10 w-full rounded-lg p-1',
          isDark ? 'bg-card/70 border border-border/70' : 'bg-muted border border-border/40'
        )}
      >
        {localDisabled ? (
          <DisabledTab
            icon={<FolderOpen className={iconClassName} />}
            label={localLabel}
            overlay={localDisabled}
            overlayIcon={<FolderPlus className={overlayIconClassName} />}
            tone={tone}
          />
        ) : (
          <Tabs.Tab value="local" className={triggerClassName}>
            <TabFace icon={<FolderOpen className={iconClassName} />} label={localLabel} />
          </Tabs.Tab>
        )}
        {githubDisabled ? (
          <DisabledTab
            icon={<Github className={iconClassName} />}
            label={githubLabel}
            overlay={githubDisabled}
            overlayIcon={<Github className={overlayIconClassName} />}
            tone={tone}
          />
        ) : (
          <Tabs.Tab value="github" className={triggerClassName}>
            <TabFace icon={<Github className={iconClassName} />} label={githubLabel} />
          </Tabs.Tab>
        )}
        <Tabs.Tab value="chat" className={triggerClassName}>
          <TabFace icon={<MessageCircle className={iconClassName} />} label={chatLabel} />
        </Tabs.Tab>
      </Tabs.List>
    </Tabs.Root>
  );
}

function DisabledTab({
  icon,
  label,
  overlay,
  overlayIcon,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  overlay: DisabledTabOverlay;
  overlayIcon: React.ReactNode;
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
      <Tooltip.Root open={tooltipOpen}>
        <Tooltip.Trigger
          delay={200}
          render={
            <button
              ref={triggerRef}
              type="button"
              onClick={handleClick}
              onPointerEnter={() => setTooltipOpen(true)}
              onPointerLeave={handlePointerLeave}
              {...stylex.props(
                styles.disabledTab,
                isDark && styles.disabledTabDark,
                styles.tooltipTab
              )}
            >
              <TabFace icon={icon} label={label} />
            </button>
          }
        />
        <Tooltip.Content
          ref={contentRef}
          side="bottom"
          sideOffset={8}
          onPointerEnter={() => setTooltipOpen(true)}
          onPointerLeave={handlePointerLeave}
        >
          {overlay.label}
        </Tooltip.Content>
      </Tooltip.Root>
    );
  }

  // Overlay mode: hover shows action text over the button
  return (
    <button
      type="button"
      data-context-disabled-action=""
      onClick={overlay.onClick}
      {...stylex.props(
        stylex.defaultMarker(),
        styles.disabledTab,
        isDark && styles.disabledTabDark,
        styles.actionTab
      )}
    >
      <span {...stylex.props(styles.faceFade)}>
        <TabFace icon={icon} label={label} />
      </span>
      <span {...stylex.props(styles.overlay, isDark ? styles.overlayDark : styles.overlayLight)}>
        {overlayIcon}
        <span>{overlay.label}</span>
      </span>
    </button>
  );
}

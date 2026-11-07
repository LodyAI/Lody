import { useCallback, useEffect, useRef, useState } from 'react';
import { FolderOpen, FolderPlus, Github, MessageCircle } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { Tabs } from '@lody/ui/tabs';
import { Tooltip } from '@lody/ui/tooltip';
import { Button } from '@lody/ui/button';
import { duration, ease, space } from '@lody/ui/tokens/scales.stylex';
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
  xstyle?: stylex.StyleXStyles;
  triggerXstyle?: stylex.StyleXStyles;
}

const styles = stylex.create({
  root: {
    width: '100%',
    maxWidth: { default: '20rem', '@media (width >= 40rem)': '24rem' },
  },
  action: { flex: '1 1 0%', minWidth: 0 },
  tooltipTab: { cursor: 'default' },
  actionTab: { position: 'relative' },
  /** Icon + label bonded as one unit so justify-* positions the pair together
   *  rather than stretching them apart (which broke affinity on the mobile
   *  new-chat Type row). */
  face: { display: 'inline-flex', alignItems: 'center', gap: space[1] },
  icon: { width: '14px', height: '14px', flexShrink: 0 },
  /** The overlay's own mark: it is not a flex item that may shrink. */
  overlayIcon: { width: '14px', height: '14px' },
  /** The overlay that replaces a disabled tab's face while the pointer is on it. */
  overlay: {
    position: 'absolute',
    inset: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[1],
    opacity: {
      default: 0,
      '@media (hover: hover)': {
        [stylex.when.ancestor(':is([data-context-disabled-action]):hover')]: 1,
      },
    },
    transitionProperty: 'opacity',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
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
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
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
  localLabel = 'Local',
  githubLabel = 'GitHub',
  chatLabel = 'Chat',
  localDisabled,
  githubDisabled,
  xstyle,
  triggerXstyle,
}: ContextSwitchProps) {
  const iconClassName = stylex.props(styles.icon).className;
  const overlayIconClassName = stylex.props(styles.overlayIcon).className;

  const triggerStyles = triggerXstyle;

  return (
    <Tabs.Root
      value={value}
      onValueChange={(v) => onChange(v as SessionContextType)}
      xstyle={[styles.root, xstyle]}
    >
      <Tabs.List stretch>
        {localDisabled ? (
          <DisabledTab
            icon={<FolderOpen className={iconClassName} />}
            label={localLabel}
            overlay={localDisabled}
            overlayIcon={<FolderPlus className={overlayIconClassName} />}
          />
        ) : (
          <Tabs.Tab value="local" xstyle={triggerStyles}>
            <TabFace icon={<FolderOpen className={iconClassName} />} label={localLabel} />
          </Tabs.Tab>
        )}
        {githubDisabled ? (
          <DisabledTab
            icon={<Github className={iconClassName} />}
            label={githubLabel}
            overlay={githubDisabled}
            overlayIcon={<Github className={overlayIconClassName} />}
          />
        ) : (
          <Tabs.Tab value="github" xstyle={triggerStyles}>
            <TabFace icon={<Github className={iconClassName} />} label={githubLabel} />
          </Tabs.Tab>
        )}
        <Tabs.Tab value="chat" xstyle={triggerStyles}>
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
}: {
  icon: React.ReactNode;
  label: string;
  overlay: DisabledTabOverlay;
  overlayIcon: React.ReactNode;
}) {
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
            <Button
              ref={triggerRef}
              type="button"
              onClick={handleClick}
              onPointerEnter={() => setTooltipOpen(true)}
              onPointerLeave={handlePointerLeave}
              variant="ghost"
              size="small"
              xstyle={[styles.action, styles.tooltipTab]}
            >
              <TabFace icon={icon} label={label} />
            </Button>
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
    <Button
      type="button"
      data-context-disabled-action=""
      onClick={overlay.onClick}
      variant="ghost"
      size="small"
      xstyle={[stylex.defaultMarker(), styles.action, styles.actionTab]}
    >
      <span {...stylex.props(styles.faceFade)}>
        <TabFace icon={icon} label={label} />
      </span>
      <span {...stylex.props(styles.overlay)}>
        {overlayIcon}
        <span>{overlay.label}</span>
      </span>
    </Button>
  );
}

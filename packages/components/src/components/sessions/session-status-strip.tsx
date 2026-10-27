import type { ComponentType, SVGProps } from 'react';
import { Trash2, WifiOff } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeFontSize,
  themeLineHeight,
  themeRadius,
  themeSpace,
} from '../../style/theme-scale.stylex';
import { FamiconsCloudOfflineOutline } from '@/components/icons/famicons-cloud-offline-outline';
import type { MachineOnlineStatus } from '@/atoms/presence';

const styles = stylex.create({
  root: {
    display: 'flex',
    alignItems: 'center',
    gap: themeSpace[2],
    borderWidth: '1px',
    borderStyle: 'solid',
    borderRadius: themeRadius.md,
    paddingInline: themeSpace[2.5],
    paddingBlock: themeSpace[1.5],
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
  },
  /** A state that blocks sending says so in the warning tone. */
  rootWarning: {
    borderColor: 'hsl(var(--status-warning) / 0.25)',
    backgroundColor: 'hsl(var(--status-warning) / 0.1)',
    color: themeColors.statusWarning,
  },
  /** An ordinary state stays in the muted ink. */
  rootMuted: {
    borderColor: 'hsl(var(--border) / 0.6)',
    backgroundColor: 'hsl(var(--muted-foreground) / 0.1)',
    color: themeColors.mutedForeground,
  },
  icon: {
    width: themeSpace[3.5],
    height: themeSpace[3.5],
    flexShrink: 0,
  },
  label: { minWidth: 0, flexGrow: 1, flexShrink: 1, flexBasis: '0%' },
});

/**
 * One priority-ordered status slot surfaced next to the composer. It answers
 * the two questions users actually have in a session: "am I looking at the
 * latest history?" and "will my message run if I send it now?". Only the
 * highest priority state renders — states hand off, they never stack:
 *
 *   1. browser-offline   — this device has no network; machine state is moot.
 *   2. machine-removed   — the machine no longer exists; sending is blocked.
 *   3. machine-offline   — presence says the machine is unreachable. Sending
 *                          stays enabled: the turn is written durably and the
 *                          CLI picks it up when the machine reconnects.
 *
 * "Machine offline" is only claimed when this client's presence subscription
 * is healthy ('offline', not 'unknown') — if we can't see presence we say
 * nothing rather than guess. Doc-stream degradation is deliberately NOT a
 * status here: the reconnect loop owns recovery and browser-offline already
 * covers the common cause, so surfacing it would mostly be noise.
 *
 * Desktop renders the compact inline form merged into the session info bar
 * (SessionInfoBar item); mobile renders the standalone strip.
 */
export type SessionStatusStripState =
  | { kind: 'browser-offline' }
  | { kind: 'machine-removed' }
  | { kind: 'machine-offline'; machineName: string | null };

export function resolveSessionStatusStripState(args: {
  browserOnline: boolean;
  machineRemoved: boolean;
  machineOnlineStatus: MachineOnlineStatus;
  machineName?: string | null;
}): SessionStatusStripState | null {
  if (!args.browserOnline) return { kind: 'browser-offline' };
  if (args.machineRemoved) return { kind: 'machine-removed' };
  if (args.machineOnlineStatus === 'offline') {
    return { kind: 'machine-offline', machineName: args.machineName ?? null };
  }
  return null;
}
type SessionStatusPresentation = {
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  text: string;
  /** Warning tone for states that block sending or imply a stale view. */
  warning: boolean;
};

export function useSessionStatusPresentation(
  state: SessionStatusStripState | null
): SessionStatusPresentation | null {
  const { t } = useTranslation();
  if (!state) return null;

  switch (state.kind) {
    case 'browser-offline': {
      const text = t('sessions.statusStrip.browserOffline', 'You are offline. Reconnect to sync.');
      return {
        Icon: WifiOff,
        text,
        warning: false,
      };
    }
    case 'machine-removed': {
      const text = t(
        'sessions.statusStrip.machineRemoved',
        'This machine was removed from the workspace. Messages can no longer be sent.'
      );
      return {
        Icon: Trash2,
        text,
        warning: true,
      };
    }
    case 'machine-offline':
      // Deliberately NOT warning-toned: an offline machine is a normal state
      // (sends still work, deferred), so it reads as info, not alarm.
      return {
        Icon: FamiconsCloudOfflineOutline,
        text: state.machineName
          ? t('sessions.statusStrip.machineOfflineNamed', {
              defaultValue: '{{machineName}} is offline',
              machineName: state.machineName,
            })
          : t('sessions.statusStrip.machineOffline', 'Machine is offline'),
        warning: false,
      };
    default:
      return null;
  }
}

/** Standalone one-line strip (mobile composer top). */
export function SessionStatusStrip({
  state,
  className,
}: {
  state: SessionStatusStripState | null;
  className?: string;
}) {
  const presentation = useSessionStatusPresentation(state);
  if (!presentation) return null;
  const { Icon, text, warning } = presentation;

  const rootProps = stylex.props(styles.root, warning ? styles.rootWarning : styles.rootMuted);

  return (
    <div {...rootProps} role="status" className={clsx(rootProps.className, className)}>
      <Icon {...stylex.props(styles.icon)} aria-hidden="true" />
      <span {...stylex.props(styles.label)}>{text}</span>
    </div>
  );
}

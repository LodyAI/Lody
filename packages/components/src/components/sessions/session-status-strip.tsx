import { workspaceFeatureUnavailableMessage } from '@/lib/workspace-feature';
import type { ComponentType, SVGProps } from 'react';
import { Trash2, WifiOff, Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { FamiconsCloudOfflineOutline } from '@/components/icons/famicons-cloud-offline-outline';
import type { MachineOnlineStatus } from '@/atoms/presence';

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
  | { kind: 'presence-unavailable' }
  | { kind: 'browser-offline' }
  | { kind: 'machine-removed' }
  | { kind: 'machine-offline'; machineName: string | null };

export function resolveSessionStatusStripState(args: {
  browserOnline: boolean;
  presenceAvailable?: boolean;
  machineRemoved: boolean;
  machineOnlineStatus: MachineOnlineStatus;
  machineName?: string | null;
}): SessionStatusStripState | null {
  if (!args.browserOnline) return { kind: 'browser-offline' };
  if (args.machineRemoved) return { kind: 'machine-removed' };
  if (args.presenceAvailable === false) return { kind: 'presence-unavailable' };
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
    case 'presence-unavailable':
      return {
        Icon: Info,
        text: workspaceFeatureUnavailableMessage('presence', t),
        warning: false,
      };
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

  return (
    <div
      role="status"
      className={cn(
        'flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs',
        warning
          ? 'border-status-warning/25 bg-status-warning/10 text-status-warning'
          : 'border-border/60 bg-muted-foreground/10 text-muted-foreground',
        className
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">{text}</span>
    </div>
  );
}

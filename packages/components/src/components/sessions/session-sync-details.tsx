import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { Popover } from '@lody/ui/popover';
import { Spinner } from '@lody/ui/spinner';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';
import {
  Check,
  CircleAlert,
  Clock3,
  Laptop,
  Monitor,
  MonitorSmartphone,
  Server,
  Smartphone,
  Tablet,
  Terminal,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConversationSync } from '@/lib/conversation-sync';
import { detectAppDeviceClass, isDesktopLayoutShell } from '@/lib/device-class';
import { useStableNow } from '@/hooks/use-stable-now';

type SyncView = Pick<ConversationSync, 'getSnapshot' | 'subscribe'>;
const ignoreUpdates = () => () => {};

function phaseFor(snapshot: ReturnType<SyncView['getSnapshot']>, browserOnline: boolean) {
  return !browserOnline &&
    (snapshot.document.route === 'cloud' || snapshot.history?.route === 'cloud')
    ? 'disconnected'
    : snapshot.phase;
}
const noSnapshot = () => null;

export const useConversationSyncPhase = (sync: SyncView | undefined, browserOnline: boolean) => {
  const getPhase = () => (sync ? phaseFor(sync.getSnapshot(), browserOnline) : null);
  return useSyncExternalStore(sync?.subscribe ?? ignoreUpdates, getPhase, getPhase);
};

const styles = stylex.create({
  panel: { width: 'min(25rem, calc(100vw - 24px))' },
  steps: { display: 'grid', listStyle: 'none', margin: 0, padding: 0 },
  step: { display: 'grid', gap: space[2], paddingBlock: space[3] },
  divider: { borderTopWidth: 1, borderTopStyle: 'solid', borderTopColor: colors.separator },
  stepHeader: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: space[2],
    flexWrap: 'wrap',
  },
  label: { fontWeight: 600, fontSize: text.subheadlineSize, margin: 0 },
  state: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[1],
    fontSize: text.footnoteSize,
    color: colors.secondaryLabel,
  },
  confirmed: { color: colors.success },
  attention: { color: colors.warning },
  elapsed: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[1.5],
    alignSelf: 'start',
    color: colors.secondaryLabel,
    fontSize: text.footnoteSize,
    fontVariantNumeric: 'tabular-nums',
  },
  graph: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    paddingBlock: space[2],
  },
  relayed: { gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' },
  node: {
    display: 'grid',
    justifyItems: 'center',
    alignContent: 'start',
    gap: space[1.5],
    position: 'relative',
    minWidth: 0,
    textAlign: 'center',
  },
  tile: {
    display: 'grid',
    placeItems: 'center',
    width: 48,
    height: 40,
    borderRadius: radius.medium,
    backgroundColor: colors.wellBackground,
    boxShadow: shadow.inset,
    color: colors.label,
  },
  name: {
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    overflowWrap: 'anywhere',
    wordBreak: 'keep-all',
    color: colors.label,
  },
  nodeLabel: { display: 'grid', gap: 2 },
  role: {
    color: colors.secondaryLabel,
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
  },
  arrow: {
    position: 'absolute',
    top: 14,
    insetInlineStart: 'calc(50% + 28px)',
    width: 'max(0px, calc(100% - 56px))',
    height: 12,
    backgroundColor: colors.accent,
    clipPath:
      'polygon(0 5.25px, calc(100% - 4px) 5.25px, calc(100% - 8px) 1.25px, calc(100% - 7px) 0, 100% 6px, calc(100% - 7px) 12px, calc(100% - 8px) 10.75px, calc(100% - 4px) 6.75px, 0 6.75px)',
  },
  reason: {
    color: colors.secondaryLabel,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
  },
});

function SyncWait({ since }: { since: number }) {
  const { t } = useTranslation();
  const seconds = Math.max(0, Math.floor((useStableNow(1_000).getTime() - since) / 1_000));
  return (
    <span {...stylex.props(styles.elapsed)}>
      <Clock3 size={14} aria-hidden="true" />
      {t('sessions.syncDetails.waiting', { seconds })}
    </span>
  );
}

type RouteNode = { label: string; icon: LucideIcon };

function currentDeviceIcon(): LucideIcon {
  if (isDesktopLayoutShell()) return Laptop;
  const kind = detectAppDeviceClass();
  if (kind === 'mobile') return Smartphone;
  // Safari on iPad can send a Mac user agent in desktop website mode.
  if (
    kind === 'tablet' ||
    (kind === 'desktop' && navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  ) {
    return Tablet;
  }
  return kind === 'desktop' ? Laptop : MonitorSmartphone;
}

function SyncFlow({
  source,
  relay,
  destination,
}: {
  source: RouteNode;
  relay?: RouteNode;
  destination: RouteNode;
}) {
  const { t } = useTranslation();
  const roles = [
    { node: source, role: t('sessions.syncDetails.source') },
    ...(relay ? [{ node: relay, role: t('sessions.syncDetails.relay') }] : []),
    { node: destination, role: t('sessions.syncDetails.destination') },
  ];
  const description = relay
    ? t('sessions.syncDetails.relayedFlow', {
        source: source.label,
        relay: relay.label,
        destination: destination.label,
      })
    : t('sessions.syncDetails.directFlow', {
        source: source.label,
        destination: destination.label,
      });

  return (
    <div
      role="img"
      aria-label={description}
      {...stylex.props(styles.graph, relay && styles.relayed)}
    >
      {roles.map(({ node: { label, icon: Icon }, role }, index) => (
        <div key={index} {...stylex.props(styles.node)}>
          <span {...stylex.props(styles.tile)}>
            <Icon size={20} aria-hidden="true" />
          </span>
          {index < roles.length - 1 && <span aria-hidden="true" {...stylex.props(styles.arrow)} />}
          <span {...stylex.props(styles.nodeLabel)}>
            <span {...stylex.props(styles.name)}>{label}</span>
            <span {...stylex.props(styles.role)}>{role}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

export function SessionSyncDetails({
  sync,
  browserOnline,
  historyUnconfirmedSince = null,
  machineName,
}: {
  sync: SyncView;
  browserOnline: boolean;
  historyUnconfirmedSince?: number | null;
  machineName?: string | null;
}) {
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(sync.subscribe, sync.getSnapshot, noSnapshot);
  const [offlineSince, setOfflineSince] = useState<number | null>(null);
  useEffect(() => {
    setOfflineSince(browserOnline ? null : Date.now());
  }, [browserOnline]);
  if (!snapshot) return null;
  const phases = {
    connecting: t('sessions.syncDetails.connecting'),
    syncing: t('sessions.syncDetails.syncing'),
    retrying: t('sessions.syncDetails.retrying'),
    disconnected: t('sessions.syncDetails.disconnected'),
    confirmed: t('sessions.syncDetails.confirmed'),
    unconfirmed: t('sessions.syncDetails.unconfirmed'),
  };
  const chipLabels = {
    connecting: t('sessions.syncDetails.connecting'),
    syncing: t('sessions.syncDetails.syncingShort'),
    retrying: t('sessions.syncDetails.retryingShort'),
    disconnected: t('sessions.syncDetails.disconnectedShort'),
    unconfirmed: t('sessions.syncDetails.unconfirmedShort'),
  };
  const reasons = {
    timeout: t('sessions.syncDetails.timeout'),
    connectTimeout: t('sessions.syncDetails.connectTimeout'),
    network: t('sessions.syncDetails.network'),
    authorization: t('sessions.syncDetails.authorization'),
    owner: t('sessions.syncDetails.ownerError'),
    read: t('sessions.syncDetails.readFailed'),
  };
  const entries = [
    {
      id: 'document',
      label: t(
        snapshot.history ? 'sessions.syncDetails.sessionState' : 'sessions.syncDetails.messages'
      ),
      step: snapshot.document,
    },
    ...(snapshot.history
      ? [{ id: 'history', label: t('sessions.syncDetails.messages'), step: snapshot.history }]
      : []),
  ];
  const transportPhase = phaseFor(snapshot, browserOnline);
  const unconfirmed = transportPhase === 'confirmed' && historyUnconfirmedSince !== null;
  const phase = unconfirmed ? 'unconfirmed' : transportPhase;
  const since = unconfirmed
    ? historyUnconfirmedSince
    : snapshot.phase === 'confirmed' && transportPhase === 'disconnected'
      ? offlineSince
      : snapshot.since;
  const title = t('sessions.syncDetails.title');
  const device = { label: t('sessions.syncDetails.device'), icon: currentDeviceIcon() };
  const server = { label: t('sessions.syncDetails.server'), icon: Server };
  const localRuntime = { label: t('sessions.syncDetails.localRuntime'), icon: Terminal };
  const target = { label: machineName || t('sessions.syncDetails.target'), icon: Monitor };
  return (
    <Popover.Root>
      <Popover.Trigger
        render={
          <Button
            variant="ghost"
            size="small"
            icon={phase === 'confirmed'}
            aria-label={`${title}, ${phases[phase]}`}
          />
        }
      >
        {phase === 'confirmed' ? (
          <Check size={14} />
        ) : (
          <>
            {phase === 'disconnected' || phase === 'retrying' || phase === 'unconfirmed' ? (
              <CircleAlert size={14} />
            ) : (
              <Spinner />
            )}
            {chipLabels[phase]}
          </>
        )}
      </Popover.Trigger>
      <Popover.Content side="top" align="end" {...stylex.props(styles.panel)}>
        <Popover.Header>
          <Popover.Title>{title}</Popover.Title>
          {phase !== 'confirmed' && since !== null && <SyncWait since={since} />}
        </Popover.Header>
        <ol {...stylex.props(styles.steps)}>
          {entries.map(({ id, label, step }, index) => {
            const ownerHistory = id === 'history' && step.route === 'cloud';
            const source = step.route === 'local' ? localRuntime : ownerHistory ? target : server;
            const disconnected = !browserOnline && step.route === 'cloud';
            const messagesUnconfirmed = unconfirmed && (id === 'history' || !snapshot.history);
            const stepPhase = disconnected
              ? 'disconnected'
              : messagesUnconfirmed
                ? 'unconfirmed'
                : step.phase;
            const confirmed = stepPhase === 'confirmed';
            const attention =
              stepPhase === 'disconnected' ||
              stepPhase === 'retrying' ||
              stepPhase === 'unconfirmed';
            const StateIcon = confirmed ? Check : attention ? CircleAlert : Clock3;
            const reason = disconnected
              ? reasons.network
              : messagesUnconfirmed
                ? t('sessions.syncDetails.historyMismatch')
                : step.reason && reasons[step.reason];
            return (
              <li key={id} {...stylex.props(styles.step, index > 0 && styles.divider)}>
                <div {...stylex.props(styles.stepHeader)}>
                  <h3 {...stylex.props(styles.label)}>{label}</h3>
                  <span {...stylex.props(styles.state)}>
                    <StateIcon
                      size={14}
                      aria-hidden="true"
                      {...stylex.props(
                        confirmed && styles.confirmed,
                        attention && styles.attention
                      )}
                    />
                    {phases[stepPhase]}
                  </span>
                </div>
                {step.route ? (
                  <SyncFlow
                    source={source}
                    relay={ownerHistory ? server : undefined}
                    destination={device}
                  />
                ) : (
                  <div {...stylex.props(styles.reason)}>
                    {t('sessions.syncDetails.routeUnknown')}
                  </div>
                )}
                {reason && <div {...stylex.props(styles.reason)}>{reason}</div>}
              </li>
            );
          })}
        </ol>
      </Popover.Content>
    </Popover.Root>
  );
}

import * as stylex from '@stylexjs/stylex';
import { Monitor } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MachineId } from '@lody/shared';
import { Button } from '@lody/ui/button';
import { Popover } from '@lody/ui/popover';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';

export type SessionMachineInfo = {
  machineId: MachineId;
  name: string;
  ownerName?: string | null;
  isOwn?: boolean;
  /** Omit until the host has resolved its local machine identity. */
  isCurrent?: boolean;
  onlineStatus: 'online' | 'offline' | 'unknown';
};

const styles = stylex.create({
  summary: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[1.5],
    color: colors.secondaryLabel,
    fontWeight: 400,
  },
  icon: { width: '1.15em', height: '1.15em', flexShrink: 0 },
  name: {
    // A narrow bar keeps only the icon; the name stays in the label and card.
    display: { default: null, '@container (max-width: 360px)': 'none' },
    maxWidth: { default: '12em', '@container (max-width: 560px)': '8em' },
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  offline: { color: colors.warning },
  details: {
    width: 'min(19rem, calc(100vw - 48px))',
    color: colors.label,
    overflowWrap: 'anywhere',
  },
  rows: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[3],
    margin: 0,
    marginTop: space[4],
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
  },
  row: { display: 'flex', alignItems: 'baseline', gap: space[4] },
  label: { color: colors.secondaryLabel, flexShrink: 0 },
  value: { margin: 0, marginLeft: 'auto', textAlign: 'right' },
});

/** Execution target stays visible; ownership is disclosed only in its card. */
export function SessionMachineInfo({
  machine,
  compact = false,
}: {
  machine: SessionMachineInfo;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const name = machine.name.trim();
  if (!name) return null;
  const offline = machine.onlineStatus === 'offline';
  const owner = machine.isOwn
    ? t('sessions.machineInfo.you', 'You')
    : machine.ownerName?.trim() || t('sessions.machineInfo.unknownOwner', 'Unknown owner');
  const status =
    machine.onlineStatus === 'online'
      ? t('workspace.machines.online', 'Online')
      : offline
        ? t('workspace.machines.offline', 'Offline')
        : t('sessions.machineInfo.unknownStatus', 'Status unavailable');

  return (
    <Popover.Root>
      <Popover.Trigger
        openOnHover={!compact}
        render={<Button variant="ghost" size="mini" icon={compact} />}
        aria-label={`${t('sessions.machineInfo.details', 'Machine details')}: ${name}`}
      >
        <span {...stylex.props(styles.summary, offline && styles.offline)}>
          <Monitor aria-hidden="true" {...stylex.props(styles.icon)} />
          {compact ? null : <span {...stylex.props(styles.name)}>{name}</span>}
        </span>
      </Popover.Trigger>
      <Popover.Content side="top" align="start" initialFocus={false}>
        <div {...stylex.props(styles.details)}>
          <Popover.Title>{name}</Popover.Title>
          <dl {...stylex.props(styles.rows)}>
            <div {...stylex.props(styles.row)}>
              <dt {...stylex.props(styles.label)}>
                {t('sessions.machineInfo.owner', 'Machine owner')}
              </dt>
              <dd {...stylex.props(styles.value)}>{owner}</dd>
            </div>
            {machine.isCurrent !== undefined ? (
              <div {...stylex.props(styles.row)}>
                <dt {...stylex.props(styles.label)}>
                  {t('sessions.machineInfo.device', 'Device')}
                </dt>
                <dd {...stylex.props(styles.value)}>
                  {machine.isCurrent
                    ? t('sidebar.thisDevice', 'This device')
                    : t('sessions.machineInfo.otherDevice', 'Another device')}
                </dd>
              </div>
            ) : null}
            <div {...stylex.props(styles.row)}>
              <dt {...stylex.props(styles.label)}>
                {t('sessions.machineInfo.connection', 'Connection')}
              </dt>
              <dd {...stylex.props(styles.value, offline && styles.offline)}>{status}</dd>
            </div>
          </dl>
        </div>
      </Popover.Content>
    </Popover.Root>
  );
}

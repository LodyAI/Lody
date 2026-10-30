import type { ReactNode } from 'react';
import { Folder, Monitor, User } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MachineId } from '@lody/shared';
import * as stylex from '@stylexjs/stylex';
import { useMachineOnlineStatus } from '@/hooks/use-machine-online-status';
import { UserAvatar } from '@/components/user-avatar';
import { avatar as avatarTokens } from '@lody/ui/avatar/avatar.tokens.stylex';
import { SidebarHoverCard } from '@/components/session-info-hover-card';
import {
  SessionRowStatusIndicator,
  hasSidebarGroupActivity,
  useSidebarGroupActivityDescription,
  type SidebarGroupActivity,
} from '@/components/sidebar-row-shared';
import { themeColors } from '../style/theme-colors.stylex';
import {
  themeFontSize,
  themeLineHeight,
  themeRadius,
  themeSpace,
} from '../style/theme-scale.stylex';

/** A machine's `os` (Node's `process.platform`) as people name it. */
const OS_LABELS: Readonly<Record<string, string>> = {
  darwin: 'macOS',
  linux: 'Linux',
  win32: 'Windows',
};

const styles = stylex.create({
  ownerAvatar: {
    [avatarTokens.sizeMedium]: 'calc(var(--spacing) * 3.5)',
    fontSize: '7px',
  },
  /** The pill that names an offline machine. */
  offlinePill: {
    display: 'inline-flex',
    height: themeSpace[4],
    flexShrink: 0,
    alignItems: 'center',
    borderRadius: themeRadius.full,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'hsl(var(--sidebar-foreground-muted) / 0.3)',
    paddingInline: themeSpace[1.5],
    fontSize: '10px',
    fontWeight: 400,
    lineHeight: 1,
    letterSpacing: '0rem',
    color: themeColors.sidebarForegroundMuted,
  },
  card: {
    display: 'flex',
    minWidth: 0,
    flexDirection: 'column',
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
    color: themeColors.foreground,
  },
  heading: {
    display: 'flex',
    alignItems: 'baseline',
    gap: themeSpace[2],
    marginBottom: themeSpace[2],
  },
  name: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    color: themeColors.foreground,
  },
  status: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: themeSpace[1],
    color: themeColors.mutedForeground,
  },
  statusOnline: { color: themeColors.statusSuccess },
  statusDot: {
    height: themeSpace[1.5],
    width: themeSpace[1.5],
    borderRadius: themeRadius.full,
    backgroundColor: 'hsl(var(--muted-foreground) / 0.6)',
  },
  statusDotOnline: { backgroundColor: themeColors.statusSuccess },
  rows: {
    display: 'flex',
    flexDirection: 'column',
    gap: themeSpace[1],
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: themeSpace[2],
  },
  rowIcon: {
    display: 'flex',
    height: themeSpace[3.5],
    width: themeSpace[3.5],
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    color: themeColors.mutedForeground,
  },
  rowValue: {
    display: 'flex',
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
  },
  valueText: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: themeColors.foreground,
  },
  /** A short value that never clips: the project count. */
  valuePlain: { color: themeColors.foreground },
  valueRow: {
    display: 'flex',
    minWidth: 0,
    alignItems: 'center',
    gap: themeSpace[1.5],
  },
  valueNote: {
    flexShrink: 0,
    color: themeColors.mutedForeground,
  },
  glyph: {
    height: themeSpace[3.5],
    width: themeSpace[3.5],
  },
});

export type SidebarMachineInfo = {
  machineId: MachineId;
  /** The machine's full name (the sidebar label may drop `.local`). */
  name: string;
  owner?: { name?: string | null; image?: string | null } | null;
  /** The signed-in user owns this machine. */
  isOwn: boolean;
  /** This is the device the app runs on. */
  isCurrent: boolean;
  os?: string | null;
  projectCount: number;
  /**
   * What the machine's FOLDED group hides. The header draws only the mark; the
   * card, which already owns the header's hover, says how many of each.
   */
  activity?: SidebarGroupActivity | null;
};

/**
 * "Offline" after a machine group's name. Online is the resting state and shows
 * nothing; an unknown status (presence not synced yet) shows nothing either, so
 * a machine never flashes offline while the app connects. A leaf, so presence
 * updates re-render only this pill, never the sidebar.
 */
export function SidebarMachineOfflinePill({ machineId }: { machineId: MachineId }) {
  const { t } = useTranslation();
  const status = useMachineOnlineStatus(machineId);
  if (status !== 'offline') return null;
  return (
    <span {...stylex.props(styles.offlinePill)}>{t('workspace.machines.offline', 'Offline')}</span>
  );
}

/**
 * Hovering a machine group header shows what the group is: the machine, who
 * owns it, whether it is online, its OS and how many projects it holds. The
 * header itself carries no icon; this card is where "this is a machine" is said.
 * Pass it as the header's `wrapToggle`, so it fills the label's flex slot and
 * leaves the header's action buttons (and the menus they open) uncovered.
 */
export function SidebarMachineHoverCard({
  machine,
  disabled,
  children,
}: {
  machine: SidebarMachineInfo;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <SidebarHoverCard
      disabled={disabled}
      content={<SidebarMachineCard machine={machine} />}
      triggerClassName="flex min-w-0 flex-1"
    >
      {children}
    </SidebarHoverCard>
  );
}

function SidebarMachineCard({ machine }: { machine: SidebarMachineInfo }) {
  const { t } = useTranslation();
  const status = useMachineOnlineStatus(machine.machineId);
  const activityDescription = useSidebarGroupActivityDescription(machine.activity);
  const ownerLabel = machine.isOwn
    ? t('sidebar.machineCard.yours', 'You')
    : machine.owner?.name?.trim() || t('sidebar.machineCard.unknownOwner', 'A teammate');

  const rows: Array<{ key: string; icon: ReactNode; label: string; value: ReactNode }> = [
    {
      key: 'owner',
      icon:
        !machine.isOwn && machine.owner ? (
          <UserAvatar user={machine.owner} className={stylex.props(styles.ownerAvatar).className} />
        ) : (
          <User {...stylex.props(styles.glyph)} aria-hidden="true" />
        ),
      label: t('sidebar.machineCard.owner', 'Owner'),
      value: (
        <span {...stylex.props(styles.valueRow)}>
          <span {...stylex.props(styles.valueText)}>{ownerLabel}</span>
          {machine.isCurrent ? (
            <span {...stylex.props(styles.valueNote)}>
              · {t('sidebar.thisDevice', 'This device')}
            </span>
          ) : null}
        </span>
      ),
    },
  ];
  if (machine.os) {
    rows.push({
      key: 'os',
      icon: <Monitor {...stylex.props(styles.glyph)} aria-hidden="true" />,
      label: t('sidebar.machineCard.system', 'System'),
      value: <span {...stylex.props(styles.valueText)}>{OS_LABELS[machine.os] ?? machine.os}</span>,
    });
  }
  rows.push({
    key: 'projects',
    icon: <Folder {...stylex.props(styles.glyph)} aria-hidden="true" />,
    label: t('sidebar.machineCard.projects', 'Projects'),
    value: (
      <span {...stylex.props(styles.valuePlain)}>
        {t('sidebar.machineCard.projectCount', '{{count}} projects', {
          count: machine.projectCount,
        })}
      </span>
    ),
  });

  if (machine.activity && hasSidebarGroupActivity(machine.activity) && activityDescription) {
    rows.push({
      key: 'activity',
      // The same mark the folded header draws, so the card reads as its legend.
      icon: (
        <SessionRowStatusIndicator
          isWaitingPermission={machine.activity.waiting > 0}
          isWorking={machine.activity.working > 0}
          hasUnreadMessages={machine.activity.unread > 0}
        />
      ),
      label: t('sidebar.machineCard.activity', 'Activity'),
      value: <span {...stylex.props(styles.valueText)}>{activityDescription}</span>,
    });
  }

  return (
    <div {...stylex.props(styles.card)}>
      <div {...stylex.props(styles.heading)}>
        <span {...stylex.props(styles.name)} title={machine.name}>
          {machine.name}
        </span>
        {status === 'unknown' ? null : (
          <span {...stylex.props(styles.status, status === 'online' && styles.statusOnline)}>
            <span
              aria-hidden="true"
              {...stylex.props(styles.statusDot, status === 'online' && styles.statusDotOnline)}
            />
            {status === 'online'
              ? t('workspace.machines.online', 'Online')
              : t('workspace.machines.offline', 'Offline')}
          </span>
        )}
      </div>
      <div {...stylex.props(styles.rows)}>
        {rows.map((row) => (
          <div key={row.key} {...stylex.props(styles.row)}>
            <span {...stylex.props(styles.rowIcon)} title={row.label} aria-label={row.label}>
              {row.icon}
            </span>
            <div {...stylex.props(styles.rowValue)}>{row.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

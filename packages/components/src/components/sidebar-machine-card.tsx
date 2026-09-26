import type { ReactNode } from 'react';
import { Folder, Monitor, User } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MachineId } from '@lody/shared';
import { useMachineOnlineStatus } from '@/hooks/use-machine-online-status';
import { cn } from '@/lib/utils';
import { UserAvatar } from '@/components/user-avatar';
import { SidebarHoverCard } from '@/components/session-info-hover-card';

/** A machine's `os` (Node's `process.platform`) as people name it. */
const OS_LABELS: Readonly<Record<string, string>> = {
  darwin: 'macOS',
  linux: 'Linux',
  win32: 'Windows',
};

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
    <span className="inline-flex h-4 shrink-0 items-center rounded-full border border-foreground/[0.12] px-1.5 text-[10px] font-normal leading-none tracking-normal text-muted-foreground">
      {t('workspace.machines.offline', 'Offline')}
    </span>
  );
}

/**
 * Hovering a machine group header shows what the group is: the machine, who
 * owns it, whether it is online, its OS and how many projects it holds. The
 * header itself carries no icon; this card is where "this is a machine" is said.
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
    <SidebarHoverCard disabled={disabled} content={<SidebarMachineCard machine={machine} />}>
      {children}
    </SidebarHoverCard>
  );
}

function SidebarMachineCard({ machine }: { machine: SidebarMachineInfo }) {
  const { t } = useTranslation();
  const status = useMachineOnlineStatus(machine.machineId);
  const ownerLabel = machine.isOwn
    ? t('sidebar.machineCard.yours', 'You')
    : machine.owner?.name?.trim() || t('sidebar.machineCard.unknownOwner', 'A teammate');

  const rows: Array<{ key: string; icon: ReactNode; label: string; value: ReactNode }> = [
    {
      key: 'owner',
      icon:
        !machine.isOwn && machine.owner ? (
          <UserAvatar user={machine.owner} className="h-3.5 w-3.5 text-[7px]" />
        ) : (
          <User className="h-3.5 w-3.5" aria-hidden="true" />
        ),
      label: t('sidebar.machineCard.owner', 'Owner'),
      value: (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-foreground">{ownerLabel}</span>
          {machine.isCurrent ? (
            <span className="shrink-0 text-muted-foreground">
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
      icon: <Monitor className="h-3.5 w-3.5" aria-hidden="true" />,
      label: t('sidebar.machineCard.system', 'System'),
      value: (
        <span className="min-w-0 truncate text-foreground">
          {OS_LABELS[machine.os] ?? machine.os}
        </span>
      ),
    });
  }
  rows.push({
    key: 'projects',
    icon: <Folder className="h-3.5 w-3.5" aria-hidden="true" />,
    label: t('sidebar.machineCard.projects', 'Projects'),
    value: (
      <span className="text-foreground">
        {t('sidebar.machineCard.projectCount', '{{count}} projects', {
          count: machine.projectCount,
        })}
      </span>
    ),
  });

  return (
    <div className="flex min-w-0 flex-col text-xs text-foreground">
      <div className="mb-2 flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-sm text-foreground" title={machine.name}>
          {machine.name}
        </span>
        {status === 'unknown' ? null : (
          <span
            className={cn(
              'flex shrink-0 items-center gap-1',
              status === 'online' ? 'text-status-success' : 'text-muted-foreground'
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                'h-1.5 w-1.5 rounded-full',
                status === 'online' ? 'bg-status-success' : 'bg-muted-foreground/60'
              )}
            />
            {status === 'online'
              ? t('workspace.machines.online', 'Online')
              : t('workspace.machines.offline', 'Offline')}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-1">
        {rows.map((row) => (
          <div key={row.key} className="flex items-center gap-2">
            <span
              className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-muted-foreground"
              title={row.label}
              aria-label={row.label}
            >
              {row.icon}
            </span>
            <div className="flex min-w-0 flex-1">{row.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

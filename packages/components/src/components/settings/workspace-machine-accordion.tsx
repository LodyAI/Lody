import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { MachineViewMeta } from '@lody/shared';
import { Bot, ChevronDown, Folder, Laptop, LockKeyhole } from 'lucide-react';
import { Badge } from '@/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import { UserAvatar } from '@/components/user-avatar';
import { cn } from '@/lib/utils';
import type { MachineTabOwner } from './machine-tab-list';

export type WorkspaceMachineAccordionMeta = {
  machine: MachineViewMeta;
  isOnline: boolean;
  isLocal: boolean;
  isPrivate: boolean;
  owner: MachineTabOwner | null;
  directoryCount: number;
  agentCount: number;
};

export function WorkspaceMachineAccordionSummary({
  meta,
  className,
  showOwner = true,
}: {
  meta: WorkspaceMachineAccordionMeta;
  className?: string;
  showOwner?: boolean;
}) {
  const { t } = useTranslation();
  const { machine, isLocal, isPrivate, owner, directoryCount, agentCount } = meta;

  return (
    <div
      className={cn(
        'flex min-w-0 flex-wrap items-center justify-end gap-1.5 text-[11px] text-muted-foreground',
        className
      )}
    >
      {isLocal ? (
        <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
          {t('workspace.machines.thisDevice', 'This device')}
        </Badge>
      ) : null}
      {isPrivate ? (
        <Badge variant="secondary" className="gap-1 px-1.5 py-0 text-[10px]">
          <LockKeyhole className="h-2.5 w-2.5" aria-hidden />
          {t('workspace.machines.private', 'Private')}
        </Badge>
      ) : null}
      <Badge variant="secondary" className="gap-1 px-1.5 py-0 text-[10px]">
        <Laptop className="h-2.5 w-2.5" aria-hidden />
        <span className="max-w-24 truncate">{machine.os || '-'}</span>
      </Badge>
      <Badge variant="secondary" className="px-1.5 py-0 font-mono text-[10px]">
        {machine.cliVersion ? `v${machine.cliVersion}` : t('machines.never', 'Never')}
      </Badge>
      <span className="inline-flex shrink-0 items-center gap-1 px-1">
        <Folder className="h-3 w-3" aria-hidden />
        {t('settings.machines.directoryCountSummary', {
          count: directoryCount,
          defaultValue: '{{count}} directories',
        })}
      </span>
      <span className="inline-flex shrink-0 items-center gap-1 px-1">
        <Bot className="h-3 w-3" aria-hidden />
        {t('settings.machines.agentCountSummary', {
          count: agentCount,
          defaultValue: '{{count}} Agents',
        })}
      </span>
      {showOwner ? <WorkspaceMachineOwnerAvatar owner={owner} /> : null}
    </div>
  );
}

export function WorkspaceMachineOwnerAvatar({ owner }: { owner: MachineTabOwner | null }) {
  const { t } = useTranslation();
  if (!owner) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex shrink-0 cursor-default rounded-full"
          aria-label={t('workspace.machines.ownerTooltip', { owner: owner.name })}
        >
          <UserAvatar
            user={owner}
            className="h-5 w-5 text-[9px]"
            fallbackClassName="bg-muted text-muted-foreground"
          />
        </span>
      </TooltipTrigger>
      <TooltipContent>{t('workspace.machines.ownerTooltip', { owner: owner.name })}</TooltipContent>
    </Tooltip>
  );
}

export function WorkspaceMachineCollapsedRow({
  meta,
  onExpand,
}: {
  meta: WorkspaceMachineAccordionMeta;
  onExpand: () => void;
}) {
  return (
    <section className="rounded-xl border border-border/60">
      <WorkspaceMachineAccordionRow meta={meta} expanded={false} onToggle={onExpand} />
    </section>
  );
}

export function WorkspaceMachineAccordionRow({
  meta,
  expanded,
  onToggle,
}: {
  meta: WorkspaceMachineAccordionMeta;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const machineName = meta.machine.name || meta.machine.id;
  const statusLabel = meta.isOnline
    ? t('workspace.machines.online', 'Online')
    : t('workspace.machines.offline', 'Offline');

  return (
    <div
      className={cn(
        'rounded-xl bg-card/20 transition-colors hover:bg-card/35',
        expanded && 'sticky top-0 z-20 rounded-b-none backdrop-blur'
      )}
    >
      <button
        type="button"
        className="flex min-h-12 w-full min-w-0 items-center gap-3 rounded-xl px-4 py-2 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        aria-expanded={expanded}
        aria-label={
          expanded
            ? t('settings.machines.collapseMachine', {
                machine: machineName,
                defaultValue: 'Collapse {{machine}}',
              })
            : t('settings.machines.expandMachine', {
                machine: machineName,
                defaultValue: 'Expand {{machine}}',
              })
        }
        onClick={onToggle}
      >
        <span
          role="img"
          aria-label={statusLabel}
          className={cn(
            'h-2.5 w-2.5 shrink-0 rounded-full ring-4',
            meta.isOnline
              ? 'bg-status-success ring-status-success/20'
              : 'bg-muted-foreground/50 ring-muted'
          )}
        />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
          {machineName}
        </span>
        <WorkspaceMachineAccordionSummary
          meta={meta}
          className="max-w-[70%] flex-nowrap overflow-hidden"
          showOwner={false}
        />
        <ChevronDown
          className={cn('h-4 w-4 shrink-0 text-muted-foreground', expanded && 'rotate-180')}
          aria-hidden
        />
        <WorkspaceMachineOwnerAvatar owner={meta.owner} />
      </button>
    </div>
  );
}

export function WorkspaceMachineExpandedSection({
  meta,
  onCollapse,
  children,
}: {
  meta: WorkspaceMachineAccordionMeta;
  onCollapse: () => void;
  children: ReactNode;
}) {
  const [detailReady, setDetailReady] = useState(false);

  useEffect(() => {
    if (typeof requestAnimationFrame !== 'function') {
      setDetailReady(true);
      return undefined;
    }

    // The first callback runs before the browser paints. Mounting the detail in
    // the second callback guarantees one paint of the lightweight expanded row.
    let secondFrame: number | null = null;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => setDetailReady(true));
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame !== null) cancelAnimationFrame(secondFrame);
    };
  }, []);

  return (
    <section className="relative rounded-xl border border-border/60">
      <WorkspaceMachineAccordionRow meta={meta} expanded onToggle={onCollapse} />
      <div className={cn(!detailReady && 'min-h-24')} aria-busy={!detailReady || undefined}>
        {detailReady ? children : null}
      </div>
    </section>
  );
}

import { text as uiText } from '@lody/ui/tokens/scales.stylex';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { MachineViewMeta } from '@lody/shared';
import { Bot, ChevronDown, ChevronRight, Folder, Laptop, LockKeyhole } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { Badge } from '@lody/ui/badge';
import { Button } from '@lody/ui/button';
import { Spinner } from '@lody/ui/spinner';
import { Tooltip } from '@lody/ui/tooltip';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { corner, duration, ease, focus, radius, space } from '@lody/ui/tokens/scales.stylex';
import { UserAvatar } from '@/components/user-avatar';
import { withClassName } from '@/lib/stylex';
import { settingsRecordsCard } from './compact-layout';
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

/** A small `@lody/ui` button's inline padding (`button.paddingXSmall`). */
const FLEET_STATUS_INSET = '10px';

const onlineHaloBreathe = stylex.keyframes({
  '0%, 100%': { transform: 'scale(0.875)', opacity: 0.12 },
  '50%': { transform: 'scale(1.2)', opacity: 0.28 },
});

const styles = stylex.create({
  summary: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: space[1.5],
    minWidth: 0,
    fontSize: '11px',
    color: colors.secondaryLabel,
  },
  /** In the row the summary shares one line with the name, and gives way first. */
  summaryInRow: { flexWrap: 'nowrap', overflow: 'hidden', maxWidth: '70%' },
  glyph: { width: '100%', height: '100%' },
  os: { maxWidth: '6rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  count: {
    display: 'inline-flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: space[1],
    paddingInline: space[1],
  },
  countIcon: { flexShrink: 0, width: '12px', height: '12px' },
  avatar: { display: 'inline-flex', flexShrink: 0, cursor: 'default' },

  /**
   * A machine is a settings card; its row is the card's own first line. The
   * expanded card clips rather than hides its overflow: `hidden` would make it
   * the scroller its sticky row sticks to, and the row would never stick.
   */
  card: { overflow: 'clip' },
  expandedCard: { position: 'relative' },
  /** The whole row answers the pointer. */
  row: {
    backgroundColor: {
      default: 'transparent',
      ':hover': `color-mix(in oklab, ${colors.elevatedBackground}, ${colors.label} 4%)`,
    },
    transitionProperty: 'background-color',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  /** Expanded, the row stays in view over its detail, so it takes the card's fill. */
  rowExpanded: {
    position: 'sticky',
    top: 0,
    zIndex: 20,
    backgroundColor: {
      default: colors.elevatedBackground,
      ':hover': `color-mix(in oklab, ${colors.elevatedBackground}, ${colors.label} 4%)`,
    },
  },
  toggle: {
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    gap: space[3],
    width: '100%',
    minWidth: 0,
    minHeight: '48px',
    margin: 0,
    paddingInline: space[4],
    paddingBlock: space[2],
    borderWidth: 0,
    borderRadius: radius.large,
    cornerShape: corner.round,
    backgroundColor: 'transparent',
    color: 'inherit',
    fontFamily: 'inherit',
    fontSize: '1em',
    textAlign: 'start',
    cursor: 'pointer',
    outlineStyle: 'none',
    boxShadow: {
      default: 'none',
      ':focus-visible': `inset 0 0 0 ${focus.ringWidth} ${colors.accent}`,
    },
  },
  dot: {
    position: 'relative',
    flexShrink: 0,
    width: '10px',
    height: '10px',
    borderRadius: radius.full,
    cornerShape: corner.round,
    backgroundColor: colors.tertiaryLabel,
  },
  dotOnline: {
    backgroundColor: colors.success,
  },
  /** Only the halo breathes; the solid centre continues to say "online". */
  onlineHalo: {
    position: 'absolute',
    inset: '-3px',
    borderRadius: radius.full,
    cornerShape: corner.round,
    backgroundColor: colors.success,
    opacity: 0.2,
    pointerEvents: 'none',
    animationName: {
      default: onlineHaloBreathe,
      '@media (prefers-reduced-motion: reduce)': 'none',
    },
    animationDuration: '2.8s',
    animationTimingFunction: 'linear',
    animationIterationCount: 'infinite',
  },
  name: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: uiText.footnoteSize,
    fontWeight: 400,
    color: colors.label,
  },
  chevron: {
    flexShrink: 0,
    width: '16px',
    height: '16px',
    color: colors.tertiaryLabel,
    transitionProperty: 'transform',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  chevronOpen: { transform: 'rotate(180deg)' },
  detailPending: { minHeight: '96px' },

  /**
   * Fleet list: one records card per group, laid out as a table. The header
   * line and every row share one grid, so the Owner and Status columns line up
   * down the card and the name column takes whatever the panel leaves.
   */
  fleetGrid: {
    display: 'grid',
    gridTemplateColumns: '10px minmax(0, 1fr) minmax(96px, 160px) 96px 14px',
    alignItems: 'center',
    columnGap: space[3],
    paddingInline: space[4],
  },
  fleetHead: {
    paddingBlock: space[2],
    fontSize: uiText.captionSize,
    fontWeight: 500,
    lineHeight: uiText.captionLeading,
    color: colors.tertiaryLabel,
    whiteSpace: 'nowrap',
  },
  /** The header's first label sits over the name, past the status dot's column. */
  fleetHeadName: { gridColumn: '2' },
  fleetHeadEnd: { justifySelf: 'end', paddingInlineEnd: FLEET_STATUS_INSET },
  fleetRow: {
    minHeight: '56px',
    paddingBlock: '10px',
    cursor: 'pointer',
    outlineStyle: 'none',
    backgroundColor: {
      default: 'transparent',
      ':hover': colors.hoverFill,
    },
    boxShadow: {
      default: 'none',
      ':focus-visible': `inset 0 0 0 ${focus.ringWidth} ${colors.accent}`,
    },
    transitionProperty: 'background-color',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  fleetMain: {
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  fleetNameLine: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    minWidth: 0,
  },
  fleetName: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: uiText.subheadlineSize,
    fontWeight: 500,
    color: colors.label,
  },
  fleetMeta: {
    minWidth: 0,
    fontSize: uiText.footnoteSize,
    color: colors.secondaryLabel,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  fleetMetaSep: { paddingInline: space[1], color: colors.tertiaryLabel },
  fleetMono: { fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: '0.95em' },
  fleetOwner: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    minWidth: 0,
    fontSize: uiText.footnoteSize,
    color: colors.secondaryLabel,
  },
  fleetOwnerName: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  fleetPingCell: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    minWidth: 0,
  },
  fleetPingOk: {
    color: colors.success,
    fontVariantNumeric: 'tabular-nums',
  },
  /** Status text sits where a small button's label does, so the column has one edge. */
  fleetStatusText: {
    paddingInline: FLEET_STATUS_INSET,
    fontSize: uiText.footnoteSize,
    color: colors.tertiaryLabel,
    whiteSpace: 'nowrap',
  },
  fleetChevron: {
    flexShrink: 0,
    width: '14px',
    height: '14px',
    color: colors.tertiaryLabel,
  },
});

export function WorkspaceMachineAccordionSummary({
  meta,
  className,
  showOwner = true,
}: {
  meta: WorkspaceMachineAccordionMeta;
  /** Layout only: where the summary sits in its caller. */
  className?: string;
  showOwner?: boolean;
}) {
  return <Summary meta={meta} className={className} showOwner={showOwner} inRow={false} />;
}

function Summary({
  meta,
  className,
  showOwner,
  inRow,
}: {
  meta: WorkspaceMachineAccordionMeta;
  className?: string;
  showOwner: boolean;
  inRow: boolean;
}) {
  const { t } = useTranslation();
  const { machine, isLocal, isPrivate, owner, directoryCount, agentCount } = meta;

  return (
    <div {...withClassName(stylex.props(styles.summary, inRow && styles.summaryInRow), className)}>
      {isLocal ? <Badge>{t('workspace.machines.thisDevice', 'This machine')}</Badge> : null}
      {isPrivate ? (
        <Badge icon={<LockKeyhole aria-hidden {...stylex.props(styles.glyph)} />}>
          {t('workspace.machines.private', 'Private')}
        </Badge>
      ) : null}
      <Badge icon={<Laptop aria-hidden {...stylex.props(styles.glyph)} />}>
        <span {...stylex.props(styles.os)}>{machine.os || '-'}</span>
      </Badge>
      <Badge>{machine.cliVersion ? `v${machine.cliVersion}` : t('machines.never', 'Never')}</Badge>
      <span {...stylex.props(styles.count)}>
        <Folder aria-hidden {...stylex.props(styles.countIcon)} />
        {t('settings.machines.directoryCountSummary', {
          count: directoryCount,
          defaultValue: '{{count}} directories',
        })}
      </span>
      <span {...stylex.props(styles.count)}>
        <Bot aria-hidden {...stylex.props(styles.countIcon)} />
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
    <Tooltip.Root>
      <Tooltip.Trigger
        render={
          <span
            aria-label={t('workspace.machines.ownerTooltip', { owner: owner.name })}
            {...stylex.props(styles.avatar)}
          >
            <UserAvatar user={owner} size="small" />
          </span>
        }
      />
      <Tooltip.Content>
        {t('workspace.machines.ownerTooltip', { owner: owner.name })}
      </Tooltip.Content>
    </Tooltip.Root>
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
    <section {...stylex.props(settingsRecordsCard, styles.card)}>
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
    <div {...stylex.props(styles.row, expanded && styles.rowExpanded)}>
      <button
        type="button"
        {...stylex.props(styles.toggle)}
        data-testid="settings-machine"
        data-settings-machine-id={meta.machine.id}
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
          {...stylex.props(styles.dot, meta.isOnline && styles.dotOnline)}
        >
          {meta.isOnline ? <span aria-hidden {...stylex.props(styles.onlineHalo)} /> : null}
        </span>
        <span {...stylex.props(styles.name)}>{machineName}</span>
        <Summary meta={meta} showOwner={false} inRow />
        <ChevronDown
          aria-hidden
          {...stylex.props(styles.chevron, expanded && styles.chevronOpen)}
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
    <section {...stylex.props(settingsRecordsCard, styles.card, styles.expandedCard)}>
      <WorkspaceMachineAccordionRow meta={meta} expanded onToggle={onCollapse} />
      <div
        {...stylex.props(!detailReady && styles.detailPending)}
        aria-busy={!detailReady || undefined}
      >
        {detailReady ? children : null}
      </div>
    </section>
  );
}

/**
 * The column names over a fleet card's rows, as its first line. Decorative for
 * assistive tech: every row already names its machine, owner and status.
 */
export function WorkspaceMachineFleetHeader() {
  const { t } = useTranslation();
  return (
    <div aria-hidden {...stylex.props(styles.fleetGrid, styles.fleetHead)}>
      <span {...stylex.props(styles.fleetHeadName)}>
        {t('settings.machines.columnMachine', 'Machine')}
      </span>
      <span>{t('settings.machines.columnOwner', 'Owner')}</span>
      <span {...stylex.props(styles.fleetHeadEnd)}>
        {t('settings.machines.columnStatus', 'Status')}
      </span>
    </div>
  );
}

export function WorkspaceMachineFleetRow({
  meta,
  isOwn,
  hasUpdate = false,
  pingLatencyMs = null,
  pinging = false,
  onPing,
  onOpen,
}: {
  meta: WorkspaceMachineAccordionMeta;
  isOwn: boolean;
  hasUpdate?: boolean;
  pingLatencyMs?: number | null;
  pinging?: boolean;
  onPing?: () => void;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const machineName = meta.machine.name || meta.machine.id;
  const statusLabel = meta.isOnline
    ? t('workspace.machines.online', 'Online')
    : t('workspace.machines.offline', 'Offline');
  const sep = <span {...stylex.props(styles.fleetMetaSep)}>·</span>;

  return (
    <div
      role="button"
      tabIndex={0}
      data-testid="settings-machine"
      data-settings-machine-id={meta.machine.id}
      aria-label={t('settings.machines.openMachine', {
        machine: machineName,
        defaultValue: 'Open {{machine}}',
      })}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
      {...stylex.props(styles.fleetGrid, styles.fleetRow)}
    >
      <span
        role="img"
        aria-label={statusLabel}
        {...stylex.props(styles.dot, meta.isOnline && styles.dotOnline)}
      >
        {meta.isOnline ? <span aria-hidden {...stylex.props(styles.onlineHalo)} /> : null}
      </span>

      <div {...stylex.props(styles.fleetMain)}>
        <div {...stylex.props(styles.fleetNameLine)}>
          <span {...stylex.props(styles.fleetName)}>{machineName}</span>
          {meta.isLocal ? (
            <Badge>{t('workspace.machines.thisDevice', 'This machine')}</Badge>
          ) : null}
          {hasUpdate ? (
            <Badge tone="warning">{t('settings.machines.updateBadge', 'Update')}</Badge>
          ) : null}
        </div>
        <div {...stylex.props(styles.fleetMeta)}>
          {meta.machine.os || '-'}
          {sep}
          <span {...stylex.props(styles.fleetMono)}>
            {meta.machine.cliVersion ? `v${meta.machine.cliVersion}` : t('machines.never', 'Never')}
          </span>
          {sep}
          {t('settings.machines.directoryCountSummary', {
            count: meta.directoryCount,
            defaultValue: '{{count}} directories',
          })}
          {sep}
          {t('settings.machines.agentCountSummary', {
            count: meta.agentCount,
            defaultValue: '{{count}} Agents',
          })}
        </div>
      </div>

      <div {...stylex.props(styles.fleetOwner)}>
        {meta.owner ? <UserAvatar user={meta.owner} size="small" /> : null}
        <span {...stylex.props(styles.fleetOwnerName)}>
          {isOwn
            ? t('settings.machines.ownerYou', 'You')
            : (meta.owner?.name ?? t('workspace.machines.teammate', 'Teammate'))}
        </span>
      </div>

      <div {...stylex.props(styles.fleetPingCell)}>
        {isOwn && meta.isOnline && onPing ? (
          <Button
            type="button"
            variant="ghost"
            size="small"
            disabled={pinging}
            xstyle={pingLatencyMs !== null ? styles.fleetPingOk : undefined}
            aria-label={t('settings.machines.pingMachine', {
              machine: machineName,
              defaultValue: 'Ping {{machine}}',
            })}
            onClick={(event) => {
              event.stopPropagation();
              onPing();
            }}
          >
            {pinging ? (
              <Spinner size="small" label={null} />
            ) : pingLatencyMs !== null ? (
              t('settings.agent.machinePing.latency', '{{latency}} ms', {
                latency: String(pingLatencyMs),
              })
            ) : (
              t('settings.agent.machinePing.button', 'Ping')
            )}
          </Button>
        ) : (
          <span {...stylex.props(styles.fleetStatusText)}>{statusLabel}</span>
        )}
      </div>

      <ChevronRight aria-hidden {...stylex.props(styles.fleetChevron)} />
    </div>
  );
}

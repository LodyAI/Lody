import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { MachineViewMeta } from '@lody/shared';
import { Bot, ChevronDown, Folder, Laptop, LockKeyhole } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { Badge } from '@lody/ui/badge';
import { Tooltip } from '@lody/ui/tooltip';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { corner, duration, ease, radius, space } from '@lody/ui/tokens/scales.stylex';
import { UserAvatar } from '@/components/user-avatar';
import { withClassName } from '@/lib/stylex';
import { settingsSurface as surface } from './surface';
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
    boxShadow: { default: 'none', ':focus-visible': `inset 0 0 0 2px ${colors.accent}` },
  },
  dot: {
    flexShrink: 0,
    width: '10px',
    height: '10px',
    borderRadius: radius.full,
    cornerShape: corner.round,
    backgroundColor: colors.tertiaryLabel,
  },
  dotOnline: {
    backgroundColor: colors.success,
    boxShadow: `0 0 0 3px color-mix(in oklab, ${colors.success} 20%, transparent)`,
  },
  name: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.875em',
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
      {isLocal ? <Badge>{t('workspace.machines.thisDevice', 'This device')}</Badge> : null}
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
    <section {...stylex.props(surface.card, styles.card)}>
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
        />
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
    <section {...stylex.props(surface.card, styles.card, styles.expandedCard)}>
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

import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AcpSessionMonitorSnapshot,
  AgentConfigMeta,
  MachineMonitorResourceUsage,
  MachineMonitorSnapshot,
  SessionMeta,
} from '@lody/shared';
import {
  AlertTriangle,
  Circle,
  CircleStop,
  CircleX,
  Cpu,
  Gauge,
  Hand,
  TerminalSquare,
} from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { Spinner } from '@lody/ui/spinner';
import { Button } from '@lody/ui/button';
import { Tooltip } from '@lody/ui/tooltip';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { corner, radius, space } from '@lody/ui/tokens/scales.stylex';
import { AlertDialog } from '@/ui/dialog';
import { toast } from '@/lib/toast';
import type { MachineMonitorViewState } from '@/hooks/use-machine-monitor';
import { AgentIcon, getAgentDisplayName } from '@/components/icons/agent-icon';
import { settingsSurface as surface } from './surface';

type SessionPresentationMeta = SessionMeta;

/**
 * The monitor lays itself out from its own width, not the window's: it renders
 * inside a settings panel far narrower than the window, so a viewport
 * breakpoint would put the table's columns into a panel with no room for them.
 */
const METRICS_WIDE = '@container (min-width: 420px)';
const TABLE_WIDE = '@container (min-width: 560px)';
const TABLE_COLUMNS = 'minmax(160px, 40%) repeat(4, minmax(0, 1fr)) 40px';

const styles = stylex.create({
  monitor: { containerType: 'inline-size', minWidth: 0 },
  padded: { paddingInline: space[4] },
  flush: { paddingInline: 0 },
  notice: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: space[2],
    paddingBlock: space[8],
    textAlign: 'center',
    fontSize: '0.875em',
    color: colors.secondaryLabel,
  },
  noticeMeta: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'center',
    columnGap: space[2],
    fontSize: '11px',
  },
  waiting: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[2],
    paddingBlock: '40px',
    fontSize: '0.875em',
    color: colors.secondaryLabel,
  },
  mono: { fontFamily: 'var(--font-mono, ui-monospace, monospace)' },

  metrics: { paddingBlock: space[3] },
  metricGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: { default: space[2], [METRICS_WIDE]: space[3] },
  },
  /** A metric is a block inside the machine's card: a region fill, not a card. */
  metric: {
    minWidth: 0,
    paddingInline: { default: space[2], [METRICS_WIDE]: space[3] },
    paddingBlock: { default: space[2], [METRICS_WIDE]: '10px' },
  },
  metricHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: { default: space[1], [METRICS_WIDE]: space[1.5] },
    minWidth: 0,
    fontSize: { default: '11px', [METRICS_WIDE]: '12px' },
    color: colors.secondaryLabel,
  },
  metricIcon: {
    flexShrink: 0,
    width: { default: '12px', [METRICS_WIDE]: '14px' },
    height: { default: '12px', [METRICS_WIDE]: '14px' },
  },
  truncate: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  hint: { color: colors.tertiaryLabel },
  narrowOnly: { display: { default: 'inline', [METRICS_WIDE]: 'none' } },
  wideOnly: { display: { default: 'none', [METRICS_WIDE]: 'inline' } },
  stat: {
    display: 'flex',
    alignItems: 'baseline',
    gap: { default: space[1.5], [METRICS_WIDE]: space[2] },
    marginTop: space[1],
  },
  statLabel: {
    flexShrink: 0,
    width: { default: '28px', [METRICS_WIDE]: '32px' },
    fontSize: '10px',
    color: colors.tertiaryLabel,
  },
  statValue: {
    fontSize: { default: '12px', [METRICS_WIDE]: '14px' },
    fontVariantNumeric: 'tabular-nums',
    color: colors.label,
  },

  sessions: {
    paddingTop: { default: space[4], [TABLE_WIDE]: '20px' },
    paddingBottom: { default: space[3], [TABLE_WIDE]: space[4] },
  },
  sessionsPadded: { paddingInline: { default: space[2], [TABLE_WIDE]: space[4] } },
  truncated: {
    display: 'flex',
    alignItems: 'center',
    gap: space[1.5],
    marginTop: space[2],
    fontSize: '12px',
    color: colors.warning,
  },
  truncatedIcon: { flexShrink: 0, width: '14px', height: '14px' },

  /** The session list is a region inside the card, its rows ruled; no head band. */
  table: { paddingInline: 0, paddingBlock: 0, overflow: 'hidden' },
  head: {
    display: { default: 'none', [TABLE_WIDE]: 'grid' },
    gridTemplateColumns: TABLE_COLUMNS,
    gap: '10px',
    paddingInline: space[2],
    paddingBlock: space[1.5],
    fontSize: '11px',
    color: colors.secondaryLabel,
  },
  center: { textAlign: 'center' },
  row: {
    display: 'grid',
    gridTemplateColumns: { default: 'minmax(0, 1fr) auto', [TABLE_WIDE]: TABLE_COLUMNS },
    alignItems: 'center',
    columnGap: { default: space[2], [TABLE_WIDE]: '10px' },
    rowGap: '2px',
    minHeight: '56px',
    paddingInline: { default: space[1], [TABLE_WIDE]: space[2] },
    paddingBlock: space[2],
  },
  rowHovered: { backgroundColor: colors.hoverFill },
  open: {
    gridColumn: { default: 'span 2', [TABLE_WIDE]: 'span 1' },
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    minWidth: 0,
    margin: 0,
    paddingInline: space[1],
    paddingBlock: { default: '2px', [TABLE_WIDE]: space[1] },
    borderWidth: 0,
    borderRadius: radius.small,
    cornerShape: corner.round,
    backgroundColor: 'transparent',
    color: colors.label,
    fontFamily: 'inherit',
    fontSize: '1em',
    textAlign: 'start',
    cursor: { default: 'pointer', ':disabled': 'default' },
    outlineStyle: 'none',
    boxShadow: { default: 'none', ':focus-visible': `0 0 0 2px ${colors.accent}` },
  },
  /** The agent's mark: it stands for something outside the interface, so a gray. */
  agentTile: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    width: '32px',
    height: '32px',
    borderRadius: radius.small,
    cornerShape: corner.shape,
    backgroundColor: colors.gray5,
    color: colors.label,
  },
  agentGlyph: { width: '16px', height: '16px' },
  sessionText: { minWidth: 0 },
  sessionTitle: { fontSize: { default: '0.875em', [TABLE_WIDE]: '0.8em' }, fontWeight: 400 },
  agentName: {
    display: { default: 'none', [TABLE_WIDE]: 'block' },
    fontSize: '11px',
    color: colors.secondaryLabel,
  },
  cellStatus: {
    display: { default: 'none', [TABLE_WIDE]: 'flex' },
    justifyContent: 'center',
    minWidth: 0,
  },
  cell: {
    display: { default: 'none', [TABLE_WIDE]: 'block' },
    fontSize: '12px',
    fontVariantNumeric: 'tabular-nums',
  },
  cellActions: {
    display: { default: 'none', [TABLE_WIDE]: 'flex' },
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: '2px',
  },
  /** Too narrow for columns: the figures follow the title on a line of their own. */
  compact: {
    gridColumn: 'span 2',
    display: { default: 'flex', [TABLE_WIDE]: 'none' },
    alignItems: 'center',
    gap: { default: space[1], '@container (min-width: 360px)': space[2] },
    minHeight: '32px',
    minWidth: 0,
    paddingInline: space[1],
    fontSize: { default: '11px', '@container (min-width: 360px)': '12px' },
    fontVariantNumeric: 'tabular-nums',
    color: colors.secondaryLabel,
  },
  compactStatus: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
  compactFigure: { flexShrink: 0, whiteSpace: 'nowrap' },
  compactActions: { display: 'flex', flexShrink: 0, gap: '2px' },
  glyph: { width: '100%', height: '100%' },

  status: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '20px',
    height: '20px',
    borderRadius: radius.mini,
    cornerShape: corner.round,
    outlineStyle: 'none',
    boxShadow: { default: 'none', ':focus-visible': `0 0 0 2px ${colors.accent}` },
  },
  statusLabelled: {
    display: 'flex',
    alignItems: 'center',
    gap: space[1.5],
    width: 'fit-content',
    fontSize: '11px',
    color: colors.secondaryLabel,
  },
  statusMark: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '14px',
    height: '14px',
  },
  statusGlyph: { width: '14px', height: '14px' },
  statusGlyphIdle: { width: '12px', height: '12px' },
  toneSuccess: { color: colors.success },
  toneWarning: { color: colors.warning },
  toneDestructive: { color: colors.destructive },
  toneIdle: { color: colors.tertiaryLabel },
  toneTransition: { color: colors.tertiaryLabel },
});

export function DeviceResourceMonitor({
  snapshot,
  state,
  os,
  cliVersion,
  flush = false,
  sessionMetas = [],
  agentConfigs = [],
  onOpenSession,
  onTerminateSession,
}: {
  snapshot: MachineMonitorSnapshot | null;
  state: MachineMonitorViewState;
  os?: string | null;
  cliVersion?: string | null;
  /** Desktop pills content is flush with the title — no extra horizontal inset. */
  flush?: boolean;
  sessionMetas?: readonly SessionPresentationMeta[];
  agentConfigs?: readonly AgentConfigMeta[];
  onOpenSession?: (session: AcpSessionMonitorSnapshot, meta?: SessionPresentationMeta) => void;
  onTerminateSession?: (session: AcpSessionMonitorSnapshot) => Promise<void>;
}) {
  const { t } = useTranslation();
  const versionLabel = cliVersion ? `v${cliVersion}` : null;
  const inset = flush ? styles.flush : styles.padded;
  if (state === 'disabled') {
    return (
      <div {...stylex.props(styles.notice, inset)}>
        {(os || versionLabel) && (
          <div {...stylex.props(styles.noticeMeta)}>
            {os && <span>{os}</span>}
            {os && versionLabel && <span aria-hidden>·</span>}
            {versionLabel && <span {...stylex.props(styles.mono)}>{versionLabel}</span>}
          </div>
        )}
        {t(
          'settings.devices.monitor.offline',
          'Resource monitoring is available while the device is online.'
        )}
      </div>
    );
  }
  if (!snapshot) {
    return (
      <div {...stylex.props(styles.waiting, inset)}>
        <Spinner label={null} />
        {t('settings.devices.monitor.observing', 'Waiting for a resource sample')}
      </div>
    );
  }

  const usedMemoryBytes = Math.max(
    0,
    snapshot.effectiveMemoryBytes - snapshot.availableMemoryBytes
  );

  return (
    <div {...stylex.props(styles.monitor)}>
      <section {...stylex.props(styles.metrics, inset)}>
        <div {...stylex.props(styles.metricGrid)}>
          <ResourceMetric
            icon={TerminalSquare}
            label={t('settings.devices.resources.cli', 'CLI')}
            trailing={versionLabel}
            resource={snapshot.cliControlPlane}
          />
          <ResourceMetric
            icon={Cpu}
            label={t('settings.devices.resources.sessions', 'ACP sessions')}
            mobileLabel="ACP"
            resource={snapshot.sessionsAggregate}
          />
          <div {...stylex.props(surface.formBlock, styles.metric)}>
            <div {...stylex.props(styles.metricHeader)}>
              <Gauge {...stylex.props(styles.metricIcon)} />
              <span {...stylex.props(styles.truncate)}>
                {t('settings.devices.resources.deviceInfo', 'Device info')}
              </span>
              {os && <span {...stylex.props(styles.truncate, styles.hint)}>· {os}</span>}
            </div>
            <StatRow
              label={t('settings.devices.sessions.cpu', 'CPU')}
              value={formatDeviceCpu(snapshot)}
            />
            <StatRow
              label={t('settings.devices.sessions.memoryShort', 'Mem')}
              value={
                <>
                  <span {...stylex.props(styles.narrowOnly)}>
                    {formatBytePair(usedMemoryBytes, snapshot.effectiveMemoryBytes)}
                  </span>
                  <span {...stylex.props(styles.wideOnly)}>
                    {formatBytes(usedMemoryBytes)} / {formatBytes(snapshot.effectiveMemoryBytes)}
                  </span>
                </>
              }
            />
          </div>
        </div>
      </section>

      {snapshot.sessions.length > 0 || snapshot.sessionsTruncated ? (
        <section {...stylex.props(styles.sessions, flush ? styles.flush : styles.sessionsPadded)}>
          {snapshot.sessions.length > 0 ? (
            <SessionTable
              sessions={snapshot.sessions}
              sessionMetas={sessionMetas}
              agentConfigs={agentConfigs}
              onOpenSession={onOpenSession}
              onTerminateSession={onTerminateSession}
            />
          ) : null}
          {snapshot.sessionsTruncated ? (
            <div {...stylex.props(styles.truncated)}>
              <AlertTriangle {...stylex.props(styles.truncatedIcon)} />
              {t('settings.devices.sessions.truncated', 'Only the first 100 sessions are shown.')}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function ResourceMetric({
  icon: Icon,
  label,
  mobileLabel,
  trailing,
  resource,
}: {
  icon: typeof Cpu;
  label: string;
  mobileLabel?: string;
  trailing?: ReactNode;
  resource: MachineMonitorResourceUsage;
}) {
  const { t } = useTranslation();
  return (
    <div {...stylex.props(surface.formBlock, styles.metric)}>
      <div {...stylex.props(styles.metricHeader)}>
        <Icon {...stylex.props(styles.metricIcon)} />
        {mobileLabel && (
          <span {...stylex.props(styles.truncate, styles.narrowOnly)}>{mobileLabel}</span>
        )}
        <span {...stylex.props(styles.truncate, mobileLabel != null && styles.wideOnly)}>
          {label}
        </span>
        {trailing && (
          <span {...stylex.props(styles.truncate, styles.mono, styles.hint)}>{trailing}</span>
        )}
      </div>
      <StatRow label={t('settings.devices.sessions.cpu', 'CPU')} value={formatCpu(resource)} />
      <StatRow
        label={t('settings.devices.sessions.memoryShort', 'Mem')}
        value={formatBytes(resource.memoryBytes)}
      />
    </div>
  );
}

/** Micro-label + prominent value pair used by the resource metric groups. */
function StatRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div {...stylex.props(styles.stat)}>
      <span {...stylex.props(styles.statLabel)}>{label}</span>
      <span {...stylex.props(styles.truncate, styles.statValue)}>{value}</span>
    </div>
  );
}

function SessionTable({
  sessions,
  sessionMetas,
  agentConfigs,
  onOpenSession,
  onTerminateSession,
}: {
  sessions: AcpSessionMonitorSnapshot[];
  sessionMetas: readonly SessionPresentationMeta[];
  agentConfigs: readonly AgentConfigMeta[];
  onOpenSession?: (session: AcpSessionMonitorSnapshot, meta?: SessionPresentationMeta) => void;
  onTerminateSession?: (session: AcpSessionMonitorSnapshot) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [confirmSession, setConfirmSession] = useState<AcpSessionMonitorSnapshot | null>(null);
  const [terminatingSessionId, setTerminatingSessionId] = useState<string | null>(null);
  const [hoveredSessionId, setHoveredSessionId] = useState<string | null>(null);
  const metaById = useMemo(
    () => new Map(sessionMetas.map((meta) => [meta.id, meta] as const)),
    [sessionMetas]
  );
  const configById = useMemo(
    () => new Map(agentConfigs.map((config) => [config.id, config] as const)),
    [agentConfigs]
  );

  const terminate = async (session: AcpSessionMonitorSnapshot) => {
    if (!onTerminateSession || terminatingSessionId) return;
    setTerminatingSessionId(session.sessionId);
    const minimumLoading = new Promise<void>((resolve) => setTimeout(resolve, 300));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    try {
      await onTerminateSession(session);
      await minimumLoading;
      setConfirmSession(null);
    } catch (error) {
      await minimumLoading;
      toast.error(
        t('settings.devices.sessions.terminateFailed', 'Failed to terminate ACP process'),
        {
          description: error instanceof Error ? error.message : String(error),
        }
      );
    } finally {
      setTerminatingSessionId(null);
    }
  };

  return (
    <>
      <div {...stylex.props(surface.formBlock, styles.table)}>
        <div {...stylex.props(styles.head)}>
          <span>{t('settings.devices.sessions.session', 'Session')}</span>
          <span {...stylex.props(styles.truncate, styles.center)}>
            {t('settings.devices.sessions.status', 'Status')}
          </span>
          <span {...stylex.props(styles.truncate, styles.center)}>
            {t('settings.devices.sessions.memory', 'Memory')}
          </span>
          <span {...stylex.props(styles.truncate, styles.center)}>
            {t('settings.devices.sessions.cpu', 'CPU')}
          </span>
          <span {...stylex.props(styles.truncate)}>
            {t('settings.devices.sessions.processes', 'Processes')}
          </span>
          <span aria-label={t('settings.devices.sessions.actions', 'Actions')} />
        </div>
        {sessions.map((session, index) => {
          const meta = metaById.get(session.sessionId);
          const config = meta?.agentConfigId ? configById.get(meta.agentConfigId) : undefined;
          const cliType = meta?.cliType ?? toAgentConfigCliType(session.agentCliType);
          const agentType = meta?.agentType ?? session.agentType;
          const agentName =
            config?.name ?? getAgentDisplayName(cliType, agentType) ?? agentType ?? 'ACP';
          const title = meta?.title?.trim() || t('settings.devices.sessions.untitled', 'Untitled');
          const isTerminating = terminatingSessionId === session.sessionId;
          const isHovered = hoveredSessionId === session.sessionId;
          const terminateButton = (
            <SessionActionButton
              label={t('settings.devices.sessions.terminate', 'Terminate ACP process')}
              destructive
              disabled={isTerminating}
              onClick={() => {
                if (isActiveSessionStatus(session.status)) setConfirmSession(session);
                else void terminate(session);
              }}
            >
              {isTerminating ? (
                <Spinner size="small" label={null} />
              ) : (
                <CircleStop {...stylex.props(styles.glyph)} />
              )}
            </SessionActionButton>
          );
          return (
            <div
              key={session.sessionId}
              {...stylex.props(
                styles.row,
                index > 0 && surface.lineRuled,
                isHovered && styles.rowHovered
              )}
            >
              <button
                type="button"
                disabled={!onOpenSession}
                {...stylex.props(styles.open)}
                onMouseEnter={() => {
                  if (onOpenSession) setHoveredSessionId(session.sessionId);
                }}
                onMouseLeave={() => setHoveredSessionId(null)}
                onClick={() => onOpenSession?.(session, meta)}
              >
                <div {...stylex.props(styles.agentTile)}>
                  {cliType && agentType ? (
                    <AgentIcon
                      cliType={cliType}
                      agentType={agentType}
                      brandId={config?.brandId}
                      env={config?.env}
                      className={stylex.props(styles.agentGlyph).className}
                    />
                  ) : (
                    <Cpu {...stylex.props(styles.agentGlyph)} />
                  )}
                </div>
                <div {...stylex.props(styles.sessionText)}>
                  <Tooltip.Root>
                    <Tooltip.Trigger
                      render={
                        <div {...stylex.props(styles.truncate, styles.sessionTitle)}>{title}</div>
                      }
                    />
                    <Tooltip.Content>{title}</Tooltip.Content>
                  </Tooltip.Root>
                  {/* Too narrow for columns, the row shows only the ACP logo and
                      the conversation title; the agent-type line joins the columns. */}
                  <div {...stylex.props(styles.truncate, styles.agentName)}>{agentName}</div>
                </div>
              </button>
              <div {...stylex.props(styles.cellStatus)}>
                <StatusIcon status={session.status} />
              </div>
              <div {...stylex.props(styles.truncate, styles.cell, styles.center)}>
                {formatBytes(session.resource.memoryBytes)}
              </div>
              <div {...stylex.props(styles.truncate, styles.cell, styles.center)}>
                {formatCpu(session.resource)}
              </div>
              <div {...stylex.props(styles.truncate, styles.cell)}>
                {session.resource.processCount ?? '-'}
              </div>
              <div {...stylex.props(styles.cellActions)}>
                {onTerminateSession && terminateButton}
              </div>
              <div data-session-compact-row {...stylex.props(styles.compact)}>
                <div {...stylex.props(styles.compactStatus)}>
                  <StatusIcon status={session.status} showLabel />
                </div>
                <span {...stylex.props(styles.compactFigure)}>
                  {formatCpu(session.resource)} {t('settings.devices.sessions.cpu', 'CPU')}
                </span>
                <span {...stylex.props(styles.compactFigure)}>
                  {formatBytes(session.resource.memoryBytes)}{' '}
                  {t('settings.devices.sessions.memoryShort', 'Mem')}
                </span>
                <span {...stylex.props(styles.compactFigure)}>
                  {session.resource.processCount === null
                    ? '-'
                    : t('settings.devices.sessions.processCount', '{{count}} proc', {
                        count: session.resource.processCount,
                      })}
                </span>
                <span {...stylex.props(styles.compactActions)}>
                  {onTerminateSession && terminateButton}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      <AlertDialog.Root
        open={confirmSession !== null}
        onOpenChange={(open) => !open && setConfirmSession(null)}
      >
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>
              {t(
                'settings.devices.sessions.terminateConfirmTitle',
                'Terminate running ACP process?'
              )}
            </AlertDialog.Title>
            <AlertDialog.Description>
              {t(
                'settings.devices.sessions.terminateConfirmDescription',
                'The active agent turn will stop immediately. The session and its files will remain available.'
              )}
            </AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Footer>
            <AlertDialog.Cancel>{t('common.cancel', 'Cancel')}</AlertDialog.Cancel>
            <AlertDialog.Action
              variant="destructive"
              disabled={!confirmSession}
              onClick={() => {
                const session = confirmSession;
                setConfirmSession(null);
                if (session) void terminate(session);
              }}
            >
              {t('settings.devices.sessions.terminateAction', 'Terminate')}
            </AlertDialog.Action>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </>
  );
}

function SessionActionButton({
  label,
  destructive = false,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  destructive?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={
          <Button
            type="button"
            icon
            variant="ghost"
            size="small"
            tone={destructive ? 'destructive' : 'neutral'}
            disabled={disabled}
            onClick={onClick}
            aria-label={label}
          >
            {children}
          </Button>
        }
      />
      <Tooltip.Content>{label}</Tooltip.Content>
    </Tooltip.Root>
  );
}

function toAgentConfigCliType(value: string | null) {
  return value === 'builtin' || value === 'registry' || value === 'custom' ? value : null;
}

function isActiveSessionStatus(status: AcpSessionMonitorSnapshot['status']): boolean {
  return (
    status === 'initializing' ||
    status === 'running' ||
    status === 'waiting_permission' ||
    status === 'finalizing'
  );
}

function StatusIcon({
  status,
  showLabel = false,
}: {
  status: AcpSessionMonitorSnapshot['status'];
  /** Touch layouts show the status text inline — tooltips are unreachable there. */
  showLabel?: boolean;
}) {
  const { t } = useTranslation();
  const label = t(`settings.devices.status.${status}`, status.replace('_', ' '));
  // The mark carries the tone; a Spinner draws in the colour it stands in.
  const tone = (() => {
    switch (status) {
      case 'running':
        return styles.toneSuccess;
      case 'waiting_permission':
        return styles.toneWarning;
      case 'failed':
        return styles.toneDestructive;
      case 'idle':
        return styles.toneIdle;
      default:
        return styles.toneTransition;
    }
  })();
  const icon = (() => {
    switch (status) {
      case 'running':
        return <Spinner size="small" label={null} />;
      case 'waiting_permission':
        return <Hand {...stylex.props(styles.statusGlyph)} />;
      case 'failed':
        return <CircleX {...stylex.props(styles.statusGlyph)} />;
      case 'idle':
        return <Circle {...stylex.props(styles.statusGlyphIdle)} />;
      // initializing / finalizing / stopping — transitional states
      default:
        return <Spinner size="small" label={null} />;
    }
  })();
  if (showLabel) {
    return (
      <span {...stylex.props(styles.statusLabelled)}>
        <span aria-hidden {...stylex.props(styles.statusMark, tone)}>
          {icon}
        </span>
        {label}
      </span>
    );
  }
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={
          <span role="img" aria-label={label} tabIndex={0} {...stylex.props(styles.status, tone)}>
            {icon}
          </span>
        }
      />
      <Tooltip.Content>{label}</Tooltip.Content>
    </Tooltip.Root>
  );
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function formatBytePair(usedBytes: number, totalBytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let divisor = 1;
  let unit = 0;
  while (totalBytes / divisor >= 1024 && unit < units.length - 1) {
    divisor *= 1024;
    unit += 1;
  }
  const formatValue = (bytes: number) => {
    const value = bytes / divisor;
    return value === 0 || value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1);
  };
  return `${formatValue(usedBytes)}/${formatValue(totalBytes)} ${units[unit]}`;
}

function formatCpu(resource: MachineMonitorResourceUsage): string {
  if (resource.cpuCores === null) return '-';
  return formatPercent(resource.cpuCores * 100);
}

function formatDeviceCpu(snapshot: MachineMonitorSnapshot): string {
  if (snapshot.deviceCpuCores === null || snapshot.deviceCpuCores === undefined) return '-';
  return formatPercent(snapshot.deviceCpuCores * 100);
}

function formatPercent(percent: number): string {
  return `${percent.toFixed(percent > 0 && percent < 10 ? 1 : 0)}%`;
}

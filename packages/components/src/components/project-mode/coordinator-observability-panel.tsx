import * as stylex from '@stylexjs/stylex';
import {
  findFreshSessionPresenceState,
  type MachineId,
  type SessionCoordinatorDiagnosticsResponse,
  type SessionHistory,
  type SessionHistoryParsed,
  type SessionId,
  type SessionPullRequestView,
  type WorkspaceId,
} from '@lody/shared';
import type { ConversationView } from '@/lib/conversation-view';
import { Button } from '@lody/ui/button';
import { Dialog } from '@lody/ui/dialog';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { useAtomValue } from 'jotai';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Database,
  Eye,
  GitPullRequest,
  Layers,
  Pause,
  Play,
  Radar,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Users,
  Zap,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { currentWorkspaceIdAtom, userAtom } from '@/atoms';
import { lodyPresenceNowMsAtom, lodyPresenceStatesAtom } from '@/atoms/presence';
import { useSessionDoc } from '@/hooks/use-session-doc';
import { sendLocalSessionControl } from '@/lib/electron-ipc-client';
import { openExternalUrl } from '@/lib/native-browser';
import { buildSupersededCoordinatorCardKeys } from './coordinator-action-engine';
import { useCoordinatorConversation } from './coordinator-conversation';
import {
  buildCoordinatorObservabilitySnapshot,
  type CoordinatorObservabilitySnapshot,
  type CoordinatorTraceEvent,
  type ObservabilityEventLayer,
  type ObservabilityTopologyEdgeId,
  type ObservabilityTopologyNodeId,
} from './coordinator-observability-model';
import { formatTaskNumber } from './project-board';
import { resolveOwnerSessionForPullRequest, type ProjectBoardRow } from './project-board-model';

const pulseDot = stylex.keyframes({
  '0%, 100%': { opacity: 1, transform: 'scale(1)' },
  '50%': { opacity: 0.45, transform: 'scale(0.82)' },
});

const dashFlow = stylex.keyframes({
  from: { strokeDashoffset: 36 },
  to: { strokeDashoffset: 0 },
});

const cardGlow = stylex.keyframes({
  '0%, 100%': { boxShadow: `0 0 0 1px color-mix(in oklab, transparent, ${colors.accent} 45%)` },
  '50%': {
    boxShadow: `0 0 18px -2px color-mix(in oklab, transparent, ${colors.accent} 32%), 0 0 0 1.5px ${colors.accent}`,
  },
});

const ACCENT_SOFT = `color-mix(in oklab, transparent, ${colors.accent} 12%)`;
const ACCENT_BORDER = `color-mix(in oklab, transparent, ${colors.accent} 38%)`;
const WARNING_SOFT = `color-mix(in oklab, transparent, ${colors.warning} 14%)`;
const WARNING_BORDER = `color-mix(in oklab, transparent, ${colors.warning} 40%)`;
const SUCCESS_SOFT = `color-mix(in oklab, transparent, ${colors.success} 14%)`;
const DANGER_SOFT = `color-mix(in oklab, transparent, ${colors.destructive} 14%)`;
const SUBTLE_FILL = `color-mix(in oklab, transparent, ${colors.label} 4%)`;
const SUBTLE_HOVER = `color-mix(in oklab, transparent, ${colors.label} 7.5%)`;

const styles = stylex.create({
  triggerBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    height: 28,
    paddingInline: 10,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.separator,
    borderRadius: radius.full,
    backgroundColor: { default: colors.elevatedBackground, ':hover': colors.hoverFill },
    color: colors.label,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    fontWeight: 500,
    cursor: 'pointer',
    flexShrink: 0,
    transitionProperty: 'background-color, border-color, color',
    transitionDuration: '140ms',
  },
  triggerBtnActive: {
    borderColor: ACCENT_BORDER,
    backgroundColor: { default: ACCENT_SOFT, ':hover': ACCENT_SOFT },
  },
  triggerDot: {
    width: 7,
    height: 7,
    borderRadius: radius.full,
    backgroundColor: colors.tertiaryLabel,
    flexShrink: 0,
  },
  triggerDotLive: {
    backgroundColor: colors.accent,
    animationName: pulseDot,
    animationDuration: '1.8s',
    animationIterationCount: 'infinite',
  },
  triggerDotWarn: {
    backgroundColor: colors.warning,
    animationName: pulseDot,
    animationDuration: '1.5s',
    animationIterationCount: 'infinite',
  },
  triggerCount: {
    paddingInline: 5,
    borderRadius: radius.full,
    backgroundColor: SUBTLE_FILL,
    color: colors.secondaryLabel,
    fontVariantNumeric: 'tabular-nums',
    fontSize: 11,
  },

  shell: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: 'min(860px, 88vh)',
    minHeight: 620,
    backgroundColor: colors.background,
    color: colors.label,
    overflow: 'hidden',
  },
  topBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[3],
    paddingBlock: space[3],
    paddingLeft: space[4],
    paddingRight: 48,
    borderBottomWidth: 1,
    borderBottomStyle: 'solid',
    borderBottomColor: colors.separator,
    backgroundColor: colors.elevatedBackground,
    flexShrink: 0,
  },
  topTitleGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    minWidth: 0,
  },
  radarBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 30,
    height: 30,
    borderRadius: radius.medium,
    backgroundColor: ACCENT_SOFT,
    color: colors.accent,
    flexShrink: 0,
  },
  titleStack: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
  },
  titleMain: {
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
    fontWeight: 600,
    color: colors.label,
  },
  titleSub: {
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.secondaryLabel,
  },
  topControls: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    flexShrink: 0,
  },
  metricPills: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
  },
  metricPill: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    height: 24,
    paddingInline: 8,
    borderRadius: radius.full,
    backgroundColor: SUBTLE_FILL,
    color: colors.secondaryLabel,
    fontSize: 11,
    fontVariantNumeric: 'tabular-nums',
  },
  metricPillAccent: {
    backgroundColor: ACCENT_SOFT,
    color: colors.accent,
    fontWeight: 600,
  },
  metricPillWarn: {
    backgroundColor: WARNING_SOFT,
    color: colors.warning,
    fontWeight: 600,
  },
  replayGroup: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 2,
    padding: 2,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.separator,
    backgroundColor: colors.background,
  },
  iconBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    height: 24,
    paddingInline: 8,
    borderWidth: 0,
    borderRadius: radius.small,
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
    color: colors.label,
    fontSize: 11,
    fontWeight: 500,
    cursor: 'pointer',
  },
  iconBtnActive: {
    backgroundColor: ACCENT_SOFT,
    color: colors.accent,
    fontWeight: 600,
  },

  topologySection: {
    position: 'relative',
    height: 248,
    flexShrink: 0,
    borderBottomWidth: 1,
    borderBottomStyle: 'solid',
    borderBottomColor: colors.separator,
    backgroundImage: `radial-gradient(color-mix(in oklab, transparent, ${colors.label} 11%) 1px, transparent 1px)`,
    backgroundSize: '18px 18px',
    backgroundColor: `color-mix(in oklab, ${colors.background}, ${colors.wellBackground} 45%)`,
    overflow: 'hidden',
  },
  topologySvg: {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    pointerEvents: 'none',
  },
  edgeBase: {
    fill: 'none',
    stroke: `color-mix(in oklab, transparent, ${colors.label} 14%)`,
    strokeWidth: 1.5,
  },
  edgeActive: {
    fill: 'none',
    stroke: colors.accent,
    strokeWidth: 2.2,
    strokeDasharray: '7 5',
    animationName: dashFlow,
    animationDuration: '0.95s',
    animationTimingFunction: 'linear',
    animationIterationCount: 'infinite',
  },
  edgeWarn: {
    stroke: colors.warning,
  },
  topologyGrid: {
    position: 'relative',
    zIndex: 1,
    display: 'grid',
    gridTemplateColumns: '1fr 1.15fr 1.1fr',
    alignItems: 'center',
    gap: space[4],
    width: '100%',
    height: '100%',
    paddingBlock: space[3],
    paddingInline: space[4],
  },
  leftNodeCol: {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'space-between',
    height: '100%',
    gap: space[2],
  },
  centerNodeCol: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
  },
  rightNodeCol: {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    height: '100%',
    gap: space[2],
  },
  topoNode: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    paddingBlock: 8,
    paddingInline: 12,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.separator,
    backgroundColor: colors.elevatedBackground,
    cursor: 'pointer',
    textAlign: 'left',
    transitionProperty: 'border-color, transform, background-color',
    transitionDuration: '160ms',
  },
  topoNodeStore: {
    width: '100%',
    maxWidth: 310,
    paddingBlock: 12,
    paddingInline: 14,
    borderRadius: radius.large,
    backgroundColor: colors.background,
  },
  topoNodeActive: {
    borderColor: colors.accent,
    animationName: cardGlow,
    animationDuration: '2.2s',
    animationIterationCount: 'infinite',
  },
  topoNodeWarn: {
    borderColor: WARNING_BORDER,
  },
  nodeHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
  },
  nodeTitleRow: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 12,
    fontWeight: 600,
    color: colors.label,
  },
  nodeSub: {
    fontSize: 11,
    lineHeight: '15px',
    color: colors.secondaryLabel,
  },
  nodeStorageTags: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 4,
    marginTop: 4,
  },
  miniTag: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 3,
    paddingBlock: 1,
    paddingInline: 6,
    borderRadius: radius.small,
    backgroundColor: SUBTLE_FILL,
    color: colors.secondaryLabel,
    fontSize: 10,
    fontWeight: 500,
  },
  miniTagAccent: {
    backgroundColor: ACCENT_SOFT,
    color: colors.accent,
  },
  miniTagWarn: {
    backgroundColor: WARNING_SOFT,
    color: colors.warning,
  },
  miniTagSuccess: {
    backgroundColor: SUCCESS_SOFT,
    color: colors.success,
  },
  miniTagDanger: {
    backgroundColor: DANGER_SOFT,
    color: colors.destructive,
  },

  activeBanner: {
    position: 'absolute',
    bottom: 8,
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 2,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    maxWidth: '82%',
    paddingBlock: 3,
    paddingInline: 12,
    borderRadius: radius.full,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: ACCENT_BORDER,
    backgroundColor: colors.elevatedBackground,
    fontSize: 11,
    color: colors.label,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },

  bottomSplit: {
    display: 'grid',
    gridTemplateColumns: 'minmax(340px, 0.95fr) minmax(420px, 1.25fr)',
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
  },
  timelinePane: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    borderRightWidth: 1,
    borderRightStyle: 'solid',
    borderRightColor: colors.separator,
    overflow: 'hidden',
  },
  paneToolbar: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
    paddingBlock: 8,
    paddingInline: space[3],
    borderBottomWidth: 1,
    borderBottomStyle: 'solid',
    borderBottomColor: colors.separator,
    backgroundColor: colors.elevatedBackground,
    flexShrink: 0,
  },
  filterRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 4,
  },
  filterBtn: {
    height: 22,
    paddingInline: 8,
    borderWidth: 0,
    borderRadius: radius.full,
    backgroundColor: { default: 'transparent', ':hover': SUBTLE_HOVER },
    color: colors.secondaryLabel,
    fontSize: 11,
    fontWeight: 500,
    cursor: 'pointer',
  },
  filterBtnActive: {
    backgroundColor: ACCENT_SOFT,
    color: colors.accent,
    fontWeight: 600,
  },
  scrollList: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    padding: space[2],
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  eventCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    paddingBlock: 8,
    paddingInline: 10,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'transparent',
    backgroundColor: { default: SUBTLE_FILL, ':hover': SUBTLE_HOVER },
    textAlign: 'left',
    cursor: 'pointer',
  },
  eventCardSelected: {
    borderColor: ACCENT_BORDER,
    backgroundColor: ACCENT_SOFT,
  },
  eventHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
  },
  eventTitle: {
    fontSize: 12,
    fontWeight: 600,
    color: colors.label,
  },
  eventSummary: {
    fontSize: 11,
    lineHeight: '15px',
    color: colors.secondaryLabel,
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  },
  eventTime: {
    fontSize: 10,
    fontVariantNumeric: 'tabular-nums',
    color: colors.tertiaryLabel,
    flexShrink: 0,
  },

  inspectorPane: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    overflow: 'hidden',
  },
  inspectorBody: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    padding: space[3],
    display: 'flex',
    flexDirection: 'column',
    gap: space[3],
  },
  sectionCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
    padding: space[3],
    borderRadius: radius.medium,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.separator,
    backgroundColor: colors.elevatedBackground,
  },
  sectionTitle: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    fontSize: 12,
    fontWeight: 600,
    color: colors.label,
  },
  codePre: {
    margin: 0,
    padding: space[2],
    borderRadius: radius.small,
    backgroundColor: colors.wellBackground,
    color: colors.label,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    fontSize: 11,
    lineHeight: '16px',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    maxHeight: 280,
    overflowY: 'auto',
  },
  linkRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
  },
  jumpBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    height: 24,
    paddingInline: 8,
    borderRadius: radius.full,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.separator,
    backgroundColor: { default: colors.background, ':hover': colors.hoverFill },
    color: colors.label,
    fontSize: 11,
    cursor: 'pointer',
  },
  auditTable: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  auditRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingBlock: 6,
    paddingInline: 8,
    borderRadius: radius.small,
    backgroundColor: SUBTLE_FILL,
    fontSize: 11,
  },
  monoText: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    fontSize: 11,
  },
  emptyHint: {
    padding: space[4],
    textAlign: 'center',
    color: colors.tertiaryLabel,
    fontSize: text.footnoteSize,
  },
});

const EDGE_PATHS: Record<ObservabilityTopologyEdgeId, string> = {
  human_to_store: 'M 290 48 C 365 48, 385 115, 455 118',
  workers_to_store: 'M 290 124 C 365 124, 395 124, 455 124',
  connectors_to_store: 'M 290 200 C 365 200, 385 133, 455 130',
  store_to_ui: 'M 455 112 C 385 95, 365 40, 290 40',
  store_to_gate: 'M 755 112 C 820 112, 845 78, 910 78',
  gate_to_coord: 'M 1045 104 L 1045 148',
  coord_to_store: 'M 910 176 C 840 176, 820 132, 755 132',
  store_to_workers: 'M 455 132 C 395 142, 365 136, 290 136',
};

type InspectorTab = 'event' | 'work_items' | 'cursor' | 'cards_gate';
type LayerFilter = 'all' | ObservabilityEventLayer;

function formatClockTime(epochMs: number): string {
  if (!epochMs || !Number.isFinite(epochMs)) return '--:--:--';
  const d = new Date(epochMs);
  return d.toLocaleTimeString([], {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatDurationShort(ms: number): string {
  if (ms <= 0) return '0s';
  if (ms < 1000) return `${Math.ceil(ms)}ms`;
  const secs = Math.ceil(ms / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

function AnimatedTopologyCanvas({
  snapshot,
  highlightedEvent,
  onSelectTab,
}: {
  snapshot: CoordinatorObservabilitySnapshot;
  highlightedEvent: CoordinatorTraceEvent | null;
  onSelectTab: (tab: InspectorTab, filter?: LayerFilter) => void;
}) {
  const { t } = useTranslation();
  const activeNodes: ReadonlySet<ObservabilityTopologyNodeId> = useMemo(
    () => (highlightedEvent ? new Set(highlightedEvent.activeNodes) : snapshot.liveActiveNodes),
    [highlightedEvent, snapshot.liveActiveNodes]
  );
  const activeEdges: ReadonlySet<ObservabilityTopologyEdgeId> = useMemo(
    () => (highlightedEvent ? new Set(highlightedEvent.activeEdges) : snapshot.liveActiveEdges),
    [highlightedEvent, snapshot.liveActiveEdges]
  );

  const isWarnEvent =
    highlightedEvent?.severity === 'warning' || highlightedEvent?.severity === 'error';

  return (
    <div {...stylex.props(styles.topologySection)} data-coordinator-observability-topology="">
      <svg
        viewBox="0 0 1200 248"
        preserveAspectRatio="none"
        {...stylex.props(styles.topologySvg)}
        aria-hidden="true"
      >
        {(Object.entries(EDGE_PATHS) as Array<[ObservabilityTopologyEdgeId, string]>).map(
          ([edgeId, pathD]) => {
            const active = activeEdges.has(edgeId);
            return (
              <g key={edgeId}>
                <path d={pathD} {...stylex.props(styles.edgeBase)} />
                {active ? (
                  <>
                    <path
                      d={pathD}
                      {...stylex.props(styles.edgeActive, isWarnEvent && styles.edgeWarn)}
                    />
                    <circle
                      r="4.2"
                      fill={isWarnEvent ? 'var(--warning, #f59e0b)' : 'var(--accent, #3b82f6)'}
                    >
                      <animateMotion dur="1.35s" repeatCount="indefinite" path={pathD} />
                    </circle>
                  </>
                ) : null}
              </g>
            );
          }
        )}
      </svg>

      <div {...stylex.props(styles.topologyGrid)}>
        <div {...stylex.props(styles.leftNodeCol)}>
          <button
            type="button"
            onClick={() => onSelectTab('cards_gate', 'cards')}
            {...stylex.props(styles.topoNode, activeNodes.has('human') && styles.topoNodeActive)}
          >
            <div {...stylex.props(styles.nodeHeader)}>
              <span {...stylex.props(styles.nodeTitleRow)}>
                <Eye size={13} />
                {t('projectMode.observability.nodeHuman', 'User & UI Projection')}
              </span>
              {snapshot.viewedChildSessionIds.size > 0 ? (
                <span {...stylex.props(styles.miniTag, styles.miniTagWarn)}>
                  {t('projectMode.observability.viewingChild', 'Viewing child')}
                </span>
              ) : null}
            </div>
            <span {...stylex.props(styles.nodeSub)}>
              {t(
                'projectMode.observability.nodeHumanSub',
                '{{open}} active card(s) · {{stale}} causally collapsed',
                {
                  open: snapshot.metrics.openCardCount,
                  stale: snapshot.metrics.supersededCardCount,
                }
              )}
            </span>
          </button>

          <button
            type="button"
            onClick={() => onSelectTab('work_items', 'squads')}
            {...stylex.props(styles.topoNode, activeNodes.has('workers') && styles.topoNodeActive)}
          >
            <div {...stylex.props(styles.nodeHeader)}>
              <span {...stylex.props(styles.nodeTitleRow)}>
                <Users size={13} />
                {t('projectMode.observability.nodeWorkers', 'Worker Squads (1..N)')}
              </span>
              {snapshot.metrics.activeWorkerCount > 0 ? (
                <span {...stylex.props(styles.miniTag, styles.miniTagAccent)}>
                  {snapshot.metrics.activeWorkerCount}{' '}
                  {t('projectMode.observability.running', 'running')}
                </span>
              ) : null}
            </div>
            <span {...stylex.props(styles.nodeSub)}>
              {t(
                'projectMode.observability.nodeWorkersSub',
                '{{sessions}} session(s) · {{direct}} direct co-work',
                {
                  sessions: snapshot.metrics.memberSessionCount,
                  direct: snapshot.metrics.directWorkItemCount,
                }
              )}
            </span>
          </button>

          <button
            type="button"
            onClick={() => onSelectTab('work_items', 'wake_gate')}
            {...stylex.props(
              styles.topoNode,
              activeNodes.has('connectors') && styles.topoNodeActive
            )}
          >
            <div {...stylex.props(styles.nodeHeader)}>
              <span {...stylex.props(styles.nodeTitleRow)}>
                <GitPullRequest size={13} />
                {t('projectMode.observability.nodeConnectors', 'Git & External Connectors')}
              </span>
              <span {...stylex.props(styles.miniTag)}>{snapshot.metrics.pullRequestCount} PR</span>
            </div>
            <span {...stylex.props(styles.nodeSub)}>
              {t(
                'projectMode.observability.nodeConnectorsSub',
                'Multi-repo PRs · CI · External refs'
              )}
            </span>
          </button>
        </div>

        <div {...stylex.props(styles.centerNodeCol)}>
          <button
            type="button"
            onClick={() => onSelectTab('cursor', 'cursor')}
            {...stylex.props(
              styles.topoNode,
              styles.topoNodeStore,
              activeNodes.has('store') && styles.topoNodeActive,
              snapshot.metrics.pendingDeltaCount > 0 && styles.topoNodeWarn
            )}
          >
            <div {...stylex.props(styles.nodeHeader)}>
              <span {...stylex.props(styles.nodeTitleRow)}>
                <Database size={14} />
                {t('projectMode.observability.nodeStore', 'Project Store (Narrow Waist)')}
              </span>
              {snapshot.metrics.pendingDeltaCount > 0 ? (
                <span {...stylex.props(styles.miniTag, styles.miniTagWarn)}>
                  +{snapshot.metrics.pendingDeltaCount} Δ
                </span>
              ) : (
                <span {...stylex.props(styles.miniTag, styles.miniTagSuccess)}>
                  {t('projectMode.observability.synced', 'Synced')}
                </span>
              )}
            </div>
            <span {...stylex.props(styles.nodeSub)}>
              {t(
                'projectMode.observability.nodeStoreSub',
                '{{count}} WorkItem(s) · Zero new Loro streams',
                { count: snapshot.metrics.workItemCount }
              )}
            </span>
            <div {...stylex.props(styles.nodeStorageTags)}>
              <span {...stylex.props(styles.miniTag)}>SessionDoc.workItems</span>
              <span {...stylex.props(styles.miniTag)}>SessionMeta</span>
              <span {...stylex.props(styles.miniTag)}>
                {snapshot.diagnosticsConnected ? 'SQLite WAL ✓' : 'Loro Replica'}
              </span>
            </div>
          </button>
        </div>

        <div {...stylex.props(styles.rightNodeCol)}>
          <button
            type="button"
            onClick={() => onSelectTab('cards_gate', 'wake_gate')}
            {...stylex.props(
              styles.topoNode,
              activeNodes.has('reconciler') && styles.topoNodeActive,
              snapshot.metrics.suppressedWatchCount > 0 && styles.topoNodeWarn
            )}
          >
            <div {...stylex.props(styles.nodeHeader)}>
              <span {...stylex.props(styles.nodeTitleRow)}>
                <ShieldAlert size={13} />
                {t('projectMode.observability.nodeGate', 'Stateless Wake Gate')}
              </span>
              {snapshot.metrics.suppressedWatchCount > 0 ? (
                <span {...stylex.props(styles.miniTag, styles.miniTagWarn)}>
                  {t('projectMode.observability.suppressed', 'Suppressed')}
                </span>
              ) : (
                <span {...stylex.props(styles.miniTag, styles.miniTagAccent)}>
                  {snapshot.metrics.activeWatchCount}{' '}
                  {t('projectMode.observability.watches', 'watch(es)')}
                </span>
              )}
            </div>
            <span {...stylex.props(styles.nodeSub)}>
              {t(
                'projectMode.observability.nodeGateSub',
                'CodeMode predicates + Focus & 4s debounce guard'
              )}
            </span>
          </button>

          <button
            type="button"
            onClick={() => onSelectTab('event', 'coordinator')}
            {...stylex.props(
              styles.topoNode,
              activeNodes.has('reconciler') && styles.topoNodeActive
            )}
          >
            <div {...stylex.props(styles.nodeHeader)}>
              <span {...stylex.props(styles.nodeTitleRow)}>
                <Zap size={13} />
                {t('projectMode.observability.nodeCoord', 'Coordinator Reconciler')}
              </span>
              <span {...stylex.props(styles.miniTag)}>diff(cursor..head)</span>
            </div>
            <span {...stylex.props(styles.nodeSub)}>
              {snapshot.lastTurnDelta?.deltaText
                ? t(
                    'projectMode.observability.lastDeltaReady',
                    'Last <project_facts_delta> injected'
                  )
                : t(
                    'projectMode.observability.reconcilerIdle',
                    'Consumes unified Store diff on wake'
                  )}
            </span>
          </button>
        </div>
      </div>

      {highlightedEvent ? (
        <div {...stylex.props(styles.activeBanner)}>
          <Sparkles size={12} />
          <strong>{highlightedEvent.badge}</strong>
          <span>{highlightedEvent.title}</span>
          <span {...stylex.props(styles.eventTime)}>
            {formatClockTime(highlightedEvent.timestampMs)}
          </span>
        </div>
      ) : null}
    </div>
  );
}

export function CoordinatorObservabilityDialog({
  open,
  onOpenChange,
  coordinatorSessionId,
  machineId,
  history,
  conversationView,
  conversationVersion,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  coordinatorSessionId: string;
  machineId?: string;
  history: readonly (SessionHistory | SessionHistoryParsed)[];
  conversationView?: ConversationView | null;
  conversationVersion?: number;
}) {
  const { t } = useTranslation();
  const coordinator = useCoordinatorConversation();
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const currentUser = useAtomValue(userAtom);
  const presenceStates = useAtomValue(lodyPresenceStatesAtom);
  const presenceNowMs = useAtomValue(lodyPresenceNowMsAtom);
  const { doc: coordinatorDoc } = useSessionDoc(coordinatorSessionId as SessionId, {
    syncEnabled: false,
  });

  const [fullHistory, setFullHistory] = useState<readonly SessionHistory[] | null>(null);
  const [diagnostics, setDiagnostics] = useState<SessionCoordinatorDiagnosticsResponse | null>(
    null
  );
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [layerFilter, setLayerFilter] = useState<LayerFilter>('all');
  const [activeTab, setActiveTab] = useState<InspectorTab>('event');
  const [isReplaying, setIsReplaying] = useState(false);
  const [replayIndex, setReplayIndex] = useState(0);

  useEffect(() => {
    if (!open || !conversationView) {
      setFullHistory(null);
      return undefined;
    }
    let cancelled = false;
    void conversationView
      .readAll()
      .then((rows) => {
        if (!cancelled) setFullHistory(rows);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [conversationVersion, conversationView, open]);

  const effectiveHistory = fullHistory ?? history;

  const fetchDiagnostics = useCallback(async () => {
    if (!workspaceId || !machineId || !coordinatorSessionId) return;
    try {
      const res = await sendLocalSessionControl({
        type: 'session/coordinator-diagnostics',
        machineId: machineId as MachineId,
        workspaceId: workspaceId as WorkspaceId,
        sessionId: coordinatorSessionId as SessionId,
      });
      if (res.ok && Array.isArray(res.responses)) {
        const found = res.responses.find(
          (item): item is SessionCoordinatorDiagnosticsResponse =>
            item.type === 'session/coordinator-diagnostics_response'
        );
        if (found) setDiagnostics(found);
      }
    } catch {
      return;
    }
  }, [coordinatorSessionId, machineId, workspaceId]);

  useEffect(() => {
    if (!open) {
      setIsReplaying(false);
      return undefined;
    }
    void fetchDiagnostics();
    const timer = setInterval(() => {
      void fetchDiagnostics();
    }, 2200);
    return () => clearInterval(timer);
  }, [fetchDiagnostics, open]);

  const tasksById = useMemo<ReadonlyMap<string, ProjectBoardRow>>(
    () => coordinator?.tasks ?? new Map<string, ProjectBoardRow>(),
    [coordinator?.tasks]
  );

  const supersededCardKeys = useMemo(
    () =>
      buildSupersededCoordinatorCardKeys({
        items: effectiveHistory.map((message, turnIndex) => ({
          type: 'message' as const,
          sessionId: coordinatorSessionId as SessionId,
          message: {
            ...message,
            items: message.items ?? [],
          } as SessionHistoryParsed,
          turnIndex,
        })),
        tasksById,
      }),
    [coordinatorSessionId, effectiveHistory, tasksById]
  );

  const snapshot = useMemo(
    () =>
      buildCoordinatorObservabilitySnapshot({
        coordinatorSessionId,
        currentUserId: currentUser?.id ?? null,
        history: effectiveHistory,
        tasksById,
        rawWorkItems: coordinatorDoc.workItems,
        presenceStates,
        supersededCardKeys,
        diagnostics,
        nowMs: presenceNowMs || Date.now(),
      }),
    [
      coordinatorDoc.workItems,
      coordinatorSessionId,
      currentUser?.id,
      diagnostics,
      effectiveHistory,
      presenceNowMs,
      presenceStates,
      supersededCardKeys,
      tasksById,
    ]
  );

  const filteredEvents = useMemo(
    () =>
      layerFilter === 'all'
        ? snapshot.events
        : snapshot.events.filter((e) => e.layer === layerFilter),
    [layerFilter, snapshot.events]
  );

  const chronologicalEvents = useMemo(() => [...filteredEvents].reverse(), [filteredEvents]);

  useEffect(() => {
    if (!isReplaying || chronologicalEvents.length === 0) return undefined;
    const timer = setInterval(() => {
      setReplayIndex((prev) => {
        const next = (prev + 1) % chronologicalEvents.length;
        const target = chronologicalEvents[next];
        if (target) setSelectedEventId(target.id);
        return next;
      });
    }, 1500);
    return () => clearInterval(timer);
  }, [chronologicalEvents, isReplaying]);

  const selectedEvent = useMemo(() => {
    if (selectedEventId) {
      const found = snapshot.events.find((e) => e.id === selectedEventId);
      if (found) return found;
    }
    return filteredEvents[0] ?? null;
  }, [filteredEvents, selectedEventId, snapshot.events]);

  const handleSelectTopologyNode = useCallback((tab: InspectorTab, filter?: LayerFilter) => {
    setActiveTab(tab);
    if (filter) setLayerFilter(filter);
  }, []);

  const handleStepReplay = (delta: -1 | 1) => {
    if (chronologicalEvents.length === 0) return;
    setIsReplaying(false);
    const currentIdx = selectedEvent
      ? chronologicalEvents.findIndex((e) => e.id === selectedEvent.id)
      : 0;
    const nextIdx =
      (Math.max(0, currentIdx) + delta + chronologicalEvents.length) % chronologicalEvents.length;
    setReplayIndex(nextIdx);
    const target = chronologicalEvents[nextIdx];
    if (target) {
      setSelectedEventId(target.id);
      setActiveTab('event');
    }
  };

  const handleToggleAutoReplay = () => {
    if (isReplaying) {
      setIsReplaying(false);
      return;
    }
    if (chronologicalEvents.length === 0) return;
    setReplayIndex(0);
    const first = chronologicalEvents[0];
    if (first) setSelectedEventId(first.id);
    setActiveTab('event');
    setIsReplaying(true);
  };

  const handleOpenChildSession = (sessionId: string) => {
    coordinator?.openTask(sessionId);
    onOpenChange(false);
  };

  const handleOpenPr = (ownerSessionId: string, pr: SessionPullRequestView) => {
    if (coordinator?.openPr) {
      coordinator.openPr(ownerSessionId, pr);
      onOpenChange(false);
      return;
    }
    void openExternalUrl(pr.url);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content
        width="min(1240px, 95vw)"
        padding="none"
        gap="none"
        data-testid="coordinator-observability-dialog"
      >
        <div {...stylex.props(styles.shell)}>
          <div {...stylex.props(styles.topBar)}>
            <div {...stylex.props(styles.topTitleGroup)}>
              <span {...stylex.props(styles.radarBadge)}>
                <Radar size={16} />
              </span>
              <div {...stylex.props(styles.titleStack)}>
                <Dialog.Title xstyle={styles.titleMain}>
                  {t(
                    'projectMode.observability.title',
                    'Coordinator Architecture & Dataflow Observatory'
                  )}
                </Dialog.Title>
                <Dialog.Description xstyle={styles.titleSub}>
                  {t(
                    'projectMode.observability.subtitle',
                    'Live Narrow-Waist Project Store, causal card snapshots, SQLite cursors, and Wake Gate traces'
                  )}
                </Dialog.Description>
              </div>
            </div>

            <div {...stylex.props(styles.topControls)}>
              <div {...stylex.props(styles.metricPills)}>
                <span {...stylex.props(styles.metricPill)}>
                  <Layers size={11} />
                  {snapshot.metrics.workItemCount} WorkItems
                </span>
                {snapshot.metrics.pendingDeltaCount > 0 ? (
                  <span {...stylex.props(styles.metricPill, styles.metricPillWarn)}>
                    +{snapshot.metrics.pendingDeltaCount} Unseen Δ
                  </span>
                ) : null}
                {snapshot.metrics.suppressedWatchCount > 0 ? (
                  <span {...stylex.props(styles.metricPill, styles.metricPillWarn)}>
                    Gate Suppressed ({snapshot.metrics.suppressedWatchCount})
                  </span>
                ) : null}
              </div>

              <div {...stylex.props(styles.replayGroup)}>
                <button
                  type="button"
                  onClick={() => handleStepReplay(-1)}
                  title={t('projectMode.observability.prevStep', 'Previous step')}
                  {...stylex.props(styles.iconBtn)}
                >
                  <ChevronLeft size={13} />
                </button>
                <button
                  type="button"
                  onClick={handleToggleAutoReplay}
                  {...stylex.props(styles.iconBtn, isReplaying && styles.iconBtnActive)}
                >
                  {isReplaying ? <Pause size={12} /> : <Play size={12} />}
                  <span>
                    {isReplaying
                      ? `${t('projectMode.observability.replaying', 'Replaying')} (${replayIndex + 1}/${chronologicalEvents.length})`
                      : t('projectMode.observability.autoReplay', 'Replay flow')}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => handleStepReplay(1)}
                  title={t('projectMode.observability.nextStep', 'Next step')}
                  {...stylex.props(styles.iconBtn)}
                >
                  <ChevronRight size={13} />
                </button>
              </div>

              <Button
                variant="secondary"
                size="small"
                onClick={() => {
                  setSelectedEventId(null);
                  setIsReplaying(false);
                  void fetchDiagnostics();
                }}
              >
                <RefreshCw size={12} />
                {t('projectMode.observability.refresh', 'Refresh')}
              </Button>
            </div>
          </div>

          <AnimatedTopologyCanvas
            snapshot={snapshot}
            highlightedEvent={selectedEvent}
            onSelectTab={handleSelectTopologyNode}
          />

          <div {...stylex.props(styles.bottomSplit)}>
            <div {...stylex.props(styles.timelinePane)}>
              <div {...stylex.props(styles.paneToolbar)}>
                <div {...stylex.props(styles.filterRow)}>
                  {(
                    [
                      ['all', t('projectMode.observability.filterAll', 'All')],
                      ['coordinator', t('projectMode.observability.filterCoord', 'Coordinator')],
                      ['squads', t('projectMode.observability.filterSquads', 'Squads')],
                      ['cards', t('projectMode.observability.filterCards', 'Cards')],
                      ['cursor', t('projectMode.observability.filterCursor', 'Cursor & Δ')],
                      ['wake_gate', t('projectMode.observability.filterGate', 'Gate & PR')],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setLayerFilter(key)}
                      {...stylex.props(
                        styles.filterBtn,
                        layerFilter === key && styles.filterBtnActive
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <span {...stylex.props(styles.eventTime)}>{filteredEvents.length} events</span>
              </div>

              <div {...stylex.props(styles.scrollList)}>
                {filteredEvents.length === 0 ? (
                  <div {...stylex.props(styles.emptyHint)}>
                    {t(
                      'projectMode.observability.noEvents',
                      'No events recorded in this layer yet.'
                    )}
                  </div>
                ) : (
                  filteredEvents.map((evt) => {
                    const isSelected = selectedEvent?.id === evt.id;
                    const taskTag = formatTaskNumber(evt.taskNumber ?? null);
                    return (
                      <button
                        key={evt.id}
                        type="button"
                        onClick={() => {
                          setIsReplaying(false);
                          setSelectedEventId(evt.id);
                          setActiveTab('event');
                        }}
                        {...stylex.props(styles.eventCard, isSelected && styles.eventCardSelected)}
                      >
                        <div {...stylex.props(styles.eventHead)}>
                          <div {...stylex.props(styles.linkRow)}>
                            <span
                              {...stylex.props(
                                styles.miniTag,
                                evt.severity === 'highlight' && styles.miniTagAccent,
                                evt.severity === 'warning' && styles.miniTagWarn,
                                evt.severity === 'error' && styles.miniTagDanger
                              )}
                            >
                              {evt.badge}
                            </span>
                            {taskTag ? (
                              <span {...stylex.props(styles.miniTag)}>{taskTag}</span>
                            ) : null}
                          </div>
                          <span {...stylex.props(styles.eventTime)}>
                            {formatClockTime(evt.timestampMs)}
                          </span>
                        </div>
                        <span {...stylex.props(styles.eventTitle)}>{evt.title}</span>
                        <span {...stylex.props(styles.eventSummary)}>{evt.summary}</span>
                      </button>
                    );
                  })
                )}
              </div>
            </div>

            <div {...stylex.props(styles.inspectorPane)}>
              <div {...stylex.props(styles.paneToolbar)}>
                <div {...stylex.props(styles.filterRow)}>
                  {(
                    [
                      ['event', t('projectMode.observability.tabEvent', 'Event Trace')],
                      [
                        'work_items',
                        `${t('projectMode.observability.tabWorkItems', 'Blackboard & PRs')} (${snapshot.workItems.length})`,
                      ],
                      [
                        'cursor',
                        `${t('projectMode.observability.tabCursor', 'SQLite Cursor & Δ')} (${snapshot.cursorAudits.length})`,
                      ],
                      [
                        'cards_gate',
                        `${t('projectMode.observability.tabCardsGate', 'Cards & Wake Gate')} (${snapshot.cards.length + snapshot.watches.length})`,
                      ],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setActiveTab(key)}
                      {...stylex.props(
                        styles.filterBtn,
                        activeTab === key && styles.filterBtnActive
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div {...stylex.props(styles.inspectorBody)}>
                {activeTab === 'event' ? (
                  selectedEvent ? (
                    <div {...stylex.props(styles.sectionCard)}>
                      <div {...stylex.props(styles.sectionTitle)}>
                        <span>{selectedEvent.title}</span>
                        <span {...stylex.props(styles.eventTime)}>
                          {formatClockTime(selectedEvent.timestampMs)}
                        </span>
                      </div>
                      <span {...stylex.props(styles.nodeSub)}>{selectedEvent.summary}</span>

                      <div {...stylex.props(styles.linkRow)}>
                        <span {...stylex.props(styles.miniTag, styles.miniTagAccent)}>
                          Path: {selectedEvent.activeNodes.join(' → ')}
                        </span>
                        {selectedEvent.turnId ? (
                          <span {...stylex.props(styles.miniTag)}>
                            Turn: {selectedEvent.turnId.slice(0, 14)}
                          </span>
                        ) : null}
                      </div>

                      {selectedEvent.linkedSessionIds.length > 0 ? (
                        <div {...stylex.props(styles.linkRow)}>
                          {selectedEvent.linkedSessionIds.map((sid) => {
                            const row = tasksById.get(sid);
                            const label =
                              row?.members?.find((m) => m.session.id === sid)?.session.title ||
                              row?.session?.title ||
                              row?.workItemTitle ||
                              sid.slice(0, 12);
                            return (
                              <button
                                key={sid}
                                type="button"
                                onClick={() => handleOpenChildSession(sid)}
                                {...stylex.props(styles.jumpBtn)}
                              >
                                <ArrowRight size={11} />
                                <span>{label}</span>
                              </button>
                            );
                          })}
                        </div>
                      ) : null}

                      {selectedEvent.detailPayload ? (
                        <pre {...stylex.props(styles.codePre)}>{selectedEvent.detailPayload}</pre>
                      ) : null}
                    </div>
                  ) : (
                    <div {...stylex.props(styles.emptyHint)}>
                      {t(
                        'projectMode.observability.selectEventHint',
                        'Select any event on the left timeline to inspect its full payload and dataflow route.'
                      )}
                    </div>
                  )
                ) : null}

                {activeTab === 'work_items' ? (
                  snapshot.workItems.length === 0 ? (
                    <div {...stylex.props(styles.emptyHint)}>
                      {t(
                        'projectMode.observability.noWorkItems',
                        'No child WorkItems opened by this coordinator yet.'
                      )}
                    </div>
                  ) : (
                    snapshot.workItems.map((wi) => {
                      const ownerRow = tasksById.get(wi.workItemId);
                      return (
                        <div key={wi.workItemId} {...stylex.props(styles.sectionCard)}>
                          <div {...stylex.props(styles.sectionTitle)}>
                            <div {...stylex.props(styles.linkRow)}>
                              {wi.taskNumber !== null ? (
                                <span {...stylex.props(styles.miniTag, styles.miniTagAccent)}>
                                  T{wi.taskNumber}
                                </span>
                              ) : null}
                              <span>{wi.title}</span>
                            </div>
                            <div {...stylex.props(styles.linkRow)}>
                              <span
                                {...stylex.props(
                                  styles.miniTag,
                                  wi.mode === 'direct' ? styles.miniTagAccent : undefined
                                )}
                              >
                                mode: {wi.mode}
                              </span>
                              <span {...stylex.props(styles.miniTag)}>bucket: {wi.bucket}</span>
                            </div>
                          </div>

                          <div {...stylex.props(styles.auditTable)}>
                            {wi.members.map((m) => (
                              <div key={m.sessionId} {...stylex.props(styles.auditRow)}>
                                <div {...stylex.props(styles.linkRow)}>
                                  {m.role ? (
                                    <span {...stylex.props(styles.miniTag, styles.miniTagAccent)}>
                                      {m.role}
                                    </span>
                                  ) : null}
                                  <button
                                    type="button"
                                    onClick={() => handleOpenChildSession(m.sessionId)}
                                    {...stylex.props(styles.jumpBtn)}
                                  >
                                    <span>{m.title}</span>
                                    <ArrowRight size={11} />
                                  </button>
                                </div>
                                <div {...stylex.props(styles.linkRow)}>
                                  {m.userViewing ? (
                                    <span {...stylex.props(styles.miniTag, styles.miniTagWarn)}>
                                      viewing
                                    </span>
                                  ) : null}
                                  {m.liveStatus ? (
                                    <span {...stylex.props(styles.miniTag, styles.miniTagAccent)}>
                                      {m.liveStatus}
                                    </span>
                                  ) : null}
                                  {m.quietForMs !== null ? (
                                    <span {...stylex.props(styles.miniTag)}>
                                      quiet {formatDurationShort(m.quietForMs)}
                                    </span>
                                  ) : null}
                                </div>
                              </div>
                            ))}
                          </div>

                          {wi.pullRequests.length > 0 || wi.externalRefs.length > 0 ? (
                            <div {...stylex.props(styles.linkRow)}>
                              {wi.pullRequests.map((pr) => {
                                const ownerSid = ownerRow
                                  ? resolveOwnerSessionForPullRequest(ownerRow, pr.url)
                                  : (wi.members[0]?.sessionId ?? wi.workItemId);
                                const label =
                                  pr.repoFullName && pr.number !== null
                                    ? `${pr.repoFullName}#${pr.number} (${pr.status})`
                                    : pr.url;
                                return (
                                  <button
                                    key={pr.url}
                                    type="button"
                                    onClick={() => handleOpenPr(ownerSid, pr)}
                                    {...stylex.props(styles.jumpBtn)}
                                  >
                                    <GitPullRequest size={11} />
                                    <span>{label}</span>
                                  </button>
                                );
                              })}
                              {wi.externalRefs.map((ref) => (
                                <button
                                  key={ref.uri}
                                  type="button"
                                  onClick={() => void openExternalUrl(ref.uri)}
                                  {...stylex.props(styles.jumpBtn)}
                                >
                                  <span>
                                    {ref.kind}: {ref.label || ref.uri}
                                  </span>
                                </button>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      );
                    })
                  )
                ) : null}

                {activeTab === 'cursor' ? (
                  <>
                    <div {...stylex.props(styles.sectionCard)}>
                      <div {...stylex.props(styles.sectionTitle)}>
                        <span>
                          {t(
                            'projectMode.observability.cursorComparison',
                            'SQLite Read Cursor vs. Live SessionMeta'
                          )}
                        </span>
                        <span {...stylex.props(styles.miniTag)}>
                          {snapshot.diagnosticsConnected
                            ? 'operations.sqlite3 live'
                            : 'Waiting for local daemon'}
                        </span>
                      </div>
                      {snapshot.cursorAudits.length === 0 ? (
                        <div {...stylex.props(styles.emptyHint)}>
                          {t(
                            'projectMode.observability.noCursors',
                            'No managed child sessions yet.'
                          )}
                        </div>
                      ) : (
                        <div {...stylex.props(styles.auditTable)}>
                          {snapshot.cursorAudits.map((row) => (
                            <div key={row.sessionId} {...stylex.props(styles.auditRow)}>
                              <div {...stylex.props(styles.linkRow)}>
                                {row.taskNumber !== null ? (
                                  <span {...stylex.props(styles.miniTag)}>T{row.taskNumber}</span>
                                ) : null}
                                <strong>{row.sessionTitle}</strong>
                                <span {...stylex.props(styles.miniTag)}>{row.mode}</span>
                              </div>
                              <div {...stylex.props(styles.linkRow)}>
                                <span {...stylex.props(styles.monoText)}>
                                  cursor:{row.cursorTurnId?.slice(0, 8) ?? '∅'} → live:
                                  {row.liveTurnId?.slice(0, 8) ?? '∅'}
                                </span>
                                <span
                                  {...stylex.props(
                                    styles.miniTag,
                                    row.status === 'synced'
                                      ? styles.miniTagSuccess
                                      : styles.miniTagWarn
                                  )}
                                >
                                  {row.status}
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <div {...stylex.props(styles.sectionCard)}>
                      <div {...stylex.props(styles.sectionTitle)}>
                        <span>
                          {t(
                            'projectMode.observability.lastDeltaTitle',
                            'Last Injected <project_facts_delta>'
                          )}
                        </span>
                        {snapshot.lastTurnDelta ? (
                          <span {...stylex.props(styles.eventTime)}>
                            Turn {snapshot.lastTurnDelta.userTurnId.slice(0, 10)} ·{' '}
                            {formatClockTime(snapshot.lastTurnDelta.updatedAt)}
                          </span>
                        ) : null}
                      </div>
                      {snapshot.lastTurnDelta?.deltaText ? (
                        <pre {...stylex.props(styles.codePre)}>
                          {snapshot.lastTurnDelta.deltaText}
                        </pre>
                      ) : (
                        <span {...stylex.props(styles.nodeSub)}>
                          {t(
                            'projectMode.observability.noDeltaYet',
                            'No unseen direct child delta needed on the latest coordinator turn.'
                          )}
                        </span>
                      )}
                    </div>
                  </>
                ) : null}

                {activeTab === 'cards_gate' ? (
                  <>
                    <div {...stylex.props(styles.sectionCard)}>
                      <div {...stylex.props(styles.sectionTitle)}>
                        <span>
                          {t(
                            'projectMode.observability.wakeGateSection',
                            'CodeMode Watches & Physical Wake Gate'
                          )}
                        </span>
                        <span {...stylex.props(styles.miniTag)}>automations/ledger.sqlite</span>
                      </div>
                      {snapshot.watches.length === 0 ? (
                        <span {...stylex.props(styles.nodeSub)}>
                          {t(
                            'projectMode.observability.noWatches',
                            'No active CodeMode watch predicates registered on this coordinator.'
                          )}
                        </span>
                      ) : (
                        snapshot.watches.map((w) => (
                          <div key={w.id} {...stylex.props(styles.auditTable)}>
                            <div {...stylex.props(styles.auditRow)}>
                              <div {...stylex.props(styles.linkRow)}>
                                <span
                                  {...stylex.props(
                                    styles.miniTag,
                                    w.gateVerdict === 'pass_ready' || w.gateVerdict === 'matched'
                                      ? styles.miniTagSuccess
                                      : w.gateVerdict === 'failed'
                                        ? styles.miniTagDanger
                                        : styles.miniTagWarn
                                  )}
                                >
                                  {w.gateVerdict}
                                </span>
                                <strong>{w.reason}</strong>
                              </div>
                              <div {...stylex.props(styles.linkRow)}>
                                <span {...stylex.props(styles.miniTag)}>checks: {w.checks}</span>
                                <span {...stylex.props(styles.miniTag)}>
                                  next: {formatDurationShort(w.nextCheckInMs)}
                                </span>
                              </div>
                            </div>
                            {w.program ? (
                              <pre {...stylex.props(styles.codePre)}>{w.program}</pre>
                            ) : null}
                            {w.lastError ? (
                              <pre {...stylex.props(styles.codePre)}>{w.lastError}</pre>
                            ) : null}
                          </div>
                        ))
                      )}
                    </div>

                    <div {...stylex.props(styles.sectionCard)}>
                      <div {...stylex.props(styles.sectionTitle)}>
                        <span>
                          {t(
                            'projectMode.observability.cardSnapshotsTitle',
                            'Proactive Cards & Causal snapshotTurnBySession'
                          )}
                        </span>
                        <span {...stylex.props(styles.miniTag)}>{snapshot.cards.length} total</span>
                      </div>
                      {snapshot.cards.length === 0 ? (
                        <span {...stylex.props(styles.nodeSub)}>
                          {t(
                            'projectMode.observability.noCards',
                            'No proactive cards emitted yet.'
                          )}
                        </span>
                      ) : (
                        <div {...stylex.props(styles.auditTable)}>
                          {snapshot.cards.map((card) => (
                            <div key={card.key} {...stylex.props(styles.auditRow)}>
                              <div {...stylex.props(styles.linkRow)}>
                                <span {...stylex.props(styles.miniTag)}>{card.kind}</span>
                                <strong>{card.title}</strong>
                              </div>
                              <div {...stylex.props(styles.linkRow)}>
                                {card.snapshotChecks.map((chk) => (
                                  <span
                                    key={chk.sessionId}
                                    {...stylex.props(
                                      styles.miniTag,
                                      chk.diverged ? styles.miniTagWarn : styles.miniTagSuccess
                                    )}
                                  >
                                    {chk.diverged ? (
                                      <AlertTriangle size={10} />
                                    ) : (
                                      <CheckCircle2 size={10} />
                                    )}
                                    {chk.sessionTitle}: {chk.frozenTurnId.slice(0, 6)}
                                    {chk.diverged
                                      ? ` ≠ ${(chk.currentTurnId ?? '').slice(0, 6)}`
                                      : ' ✓'}
                                  </span>
                                ))}
                                <span
                                  {...stylex.props(
                                    styles.miniTag,
                                    card.verdict === 'open'
                                      ? styles.miniTagAccent
                                      : card.verdict === 'chosen'
                                        ? styles.miniTagSuccess
                                        : styles.miniTagWarn
                                  )}
                                >
                                  {card.verdict}
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </Dialog.Content>
    </Dialog.Root>
  );
}

/**
 * Persistent top-right header trigger inside every Project Coordinator window.
 * Keeps zero background polling while closed and opens the full animated
 * Coordinator Architecture & Dataflow Observatory on click.
 */
export function CoordinatorObservabilityHeaderButton({
  coordinatorSessionId,
  machineId,
  history,
  conversationView,
  conversationVersion,
}: {
  coordinatorSessionId: string;
  machineId?: string;
  history: readonly (SessionHistory | SessionHistoryParsed)[];
  conversationView?: ConversationView | null;
  conversationVersion?: number;
}) {
  const { t } = useTranslation();
  const coordinator = useCoordinatorConversation();
  const presenceStates = useAtomValue(lodyPresenceStatesAtom);
  const presenceNowMs = useAtomValue(lodyPresenceNowMsAtom);
  const [open, setOpen] = useState(false);

  const { taskCount, hasRunningChild, hasNeedsYou } = useMemo(() => {
    if (!coordinator) {
      return { taskCount: 0, hasRunningChild: false, hasNeedsYou: false };
    }
    const seen = new Set<string>();
    let running = false;
    let needsYou = false;
    const now = presenceNowMs || Date.now();
    for (const row of coordinator.tasks.values()) {
      const wid = row.workItemId || row.session?.id || '';
      if (!wid || seen.has(wid)) continue;
      seen.add(wid);
      if (row.bucket === 'needsYou') needsYou = true;
      const members =
        row.members && row.members.length > 0
          ? row.members
          : row.session
            ? [{ session: row.session }]
            : [];
      for (const m of members) {
        const live = findFreshSessionPresenceState(presenceStates, m.session.id, now);
        if (live?.status.type === 'running') running = true;
      }
    }
    return { taskCount: seen.size, hasRunningChild: running, hasNeedsYou: needsYou };
  }, [coordinator, presenceNowMs, presenceStates]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-coordinator-observability-trigger=""
        title={t(
          'projectMode.observability.triggerTooltip',
          'Inspect coordinator architecture, WorkItems, cursors, and live dataflow'
        )}
        {...stylex.props(styles.triggerBtn, open && styles.triggerBtnActive)}
      >
        <span
          {...stylex.props(
            styles.triggerDot,
            hasRunningChild && styles.triggerDotLive,
            !hasRunningChild && hasNeedsYou && styles.triggerDotWarn
          )}
        />
        <Activity size={13} aria-hidden="true" />
        <span>{t('projectMode.observability.triggerLabel', 'Observability')}</span>
        {taskCount > 0 ? <span {...stylex.props(styles.triggerCount)}>{taskCount}</span> : null}
      </button>

      {open ? (
        <CoordinatorObservabilityDialog
          open={open}
          onOpenChange={setOpen}
          coordinatorSessionId={coordinatorSessionId}
          machineId={machineId}
          history={history}
          conversationView={conversationView}
          conversationVersion={conversationVersion}
        />
      ) : null}
    </>
  );
}

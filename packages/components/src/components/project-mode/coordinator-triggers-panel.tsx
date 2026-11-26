import * as stylex from '@stylexjs/stylex';
import {
  CONNECTOR_PLUGIN_CATALOG,
  GITHUB_TRIGGER_EVENT_KINDS,
  applyScheduleRecurrence,
  defaultScheduleRecurrence,
  getDeviceTimeZone,
  getServerNow,
  getSessionRoomId,
  normalizeCoordinatorTriggersMap,
  parseConnectorTriggerConfig,
  resolveSessionConversationConfig,
  schedulePolicyTriggerId,
  withScheduleRecurrenceTimeZone,
  type ConnectorPluginId,
  type ConnectorPluginManifest,
  type CoordinatorConnectorStatusSummary,
  type CoordinatorTriggerAction,
  type CoordinatorTriggerDoc,
  type CoordinatorTriggerPolicyMode,
  type GitHubTriggerEventKind,
  type MachineId,
  type ScheduleRecurrence,
  type ScheduleRegistryRow,
  type SessionCoordinatorTriggersResponse,
  type SessionId,
  type SessionMeta,
  type WorkspaceId,
} from '@lody/shared';
import { readSessionHistoryMetadata } from '@lody/shared/session-data';
import { Button } from '@lody/ui/button';
import { Dialog } from '@lody/ui/dialog';
import { Input } from '@lody/ui/input';
import { Switch } from '@lody/ui/switch';
import { Textarea } from '@lody/ui/textarea';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { useAtomValue } from 'jotai';
import {
  AlertCircle,
  ArrowLeft,
  Bell,
  CalendarClock,
  Check,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Zap,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { v4 as uuid } from 'uuid';
import { currentWorkspaceIdAtom, userAtom } from '@/atoms';
import { getAllAgentConfigAtom } from '@/atoms/agents';
import { sessionMetaAtomFamily } from '@/atoms/doc-meta';
import { getMachineMetaMapAtom } from '@/atoms/machines';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { describeTrigger } from '@/components/schedules/schedule-format';
import { resolveScheduleProposalTarget } from '@/components/schedules/schedule-proposal-target';
import { ScheduleRecurrenceEditor } from '@/components/schedules/schedule-recurrence-editor';
import { useSchedules } from '@/hooks/use-schedules';
import { useSessionDoc } from '@/hooks/use-session-doc';
import { useWorkspaceAgentRoles } from '@/hooks/use-workspace-agent-roles';
import { sendLocalSessionControl } from '@/lib/electron-ipc-client';
import { toast } from '@/lib/toast';

const ACCENT_SOFT = `color-mix(in oklab, transparent, ${colors.accent} 12%)`;
const ACCENT_BORDER = `color-mix(in oklab, transparent, ${colors.accent} 40%)`;
const SUCCESS_SOFT = `color-mix(in oklab, transparent, ${colors.success} 14%)`;
const WARNING_SOFT = `color-mix(in oklab, transparent, ${colors.warning} 15%)`;
const DANGER_SOFT = `color-mix(in oklab, transparent, ${colors.destructive} 14%)`;
const SUBTLE_FILL = `color-mix(in oklab, transparent, ${colors.label} 4.5%)`;
const SUBTLE_HOVER = `color-mix(in oklab, transparent, ${colors.label} 8%)`;

const pulseDot = stylex.keyframes({
  '0%, 100%': { opacity: 1, transform: 'scale(1)' },
  '50%': { opacity: 0.45, transform: 'scale(0.84)' },
});

const styles = stylex.create({
  headerBtn: {
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
  headerBtnActive: {
    borderColor: ACCENT_BORDER,
    backgroundColor: { default: ACCENT_SOFT, ':hover': ACCENT_SOFT },
  },
  headerDot: {
    width: 7,
    height: 7,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    flexShrink: 0,
    animationName: pulseDot,
    animationDuration: '2s',
    animationIterationCount: 'infinite',
  },
  headerCount: {
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
    maxHeight: 'min(800px, 86vh)',
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
  topTitleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    minWidth: 0,
  },
  topBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 32,
    height: 32,
    borderRadius: radius.medium,
    backgroundColor: ACCENT_SOFT,
    color: colors.accent,
    flexShrink: 0,
  },
  backBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 28,
    height: 28,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.separator,
    backgroundColor: { default: 'transparent', ':hover': SUBTLE_HOVER },
    color: colors.label,
    cursor: 'pointer',
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

  bodyScroll: {
    display: 'flex',
    flexDirection: 'column',
    gap: 20,
    padding: space[4],
    overflowY: 'auto',
    flex: 1,
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  sectionHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[2],
  },
  sectionTitle: {
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    fontWeight: 600,
    color: colors.secondaryLabel,
    letterSpacing: '0.01em',
  },

  mountedList: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
  },
  mountedRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[3],
    paddingBlock: 10,
    paddingInline: space[3],
    borderRadius: radius.large,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.separator,
    backgroundColor: colors.elevatedBackground,
  },
  mountedRowPaused: {
    opacity: 0.68,
  },
  mountedLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: space[3],
    minWidth: 0,
    flex: 1,
  },
  mountedText: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    minWidth: 0,
    flex: 1,
  },
  mountedTitleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    minWidth: 0,
  },
  mountedTitle: {
    fontSize: text.bodySize,
    lineHeight: text.bodyLeading,
    fontWeight: 500,
    color: colors.label,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  mountedSummary: {
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.secondaryLabel,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  mountedError: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 11,
    color: colors.destructive,
  },
  mountedActions: {
    display: 'flex',
    alignItems: 'center',
    gap: space[1.5],
    flexShrink: 0,
  },
  policyChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    height: 24,
    paddingInline: 9,
    borderRadius: radius.full,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.separator,
    backgroundColor: { default: SUBTLE_FILL, ':hover': SUBTLE_HOVER },
    color: colors.secondaryLabel,
    fontSize: 11,
    fontWeight: 500,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  policyChipDelegate: {
    borderColor: ACCENT_BORDER,
    backgroundColor: { default: ACCENT_SOFT, ':hover': ACCENT_SOFT },
    color: colors.accent,
  },
  iconActionBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 28,
    height: 28,
    borderRadius: radius.medium,
    borderWidth: 0,
    backgroundColor: { default: 'transparent', ':hover': SUBTLE_HOVER },
    color: colors.secondaryLabel,
    cursor: 'pointer',
  },
  iconActionDanger: {
    color: { default: colors.secondaryLabel, ':hover': colors.destructive },
    backgroundColor: { default: 'transparent', ':hover': DANGER_SOFT },
  },
  emptyMountedBox: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    paddingBlock: space[3],
    paddingInline: 14,
    borderRadius: radius.large,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.separator,
    color: colors.secondaryLabel,
    fontSize: text.footnoteSize,
  },

  cardGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(238px, 1fr))',
    gap: space[3],
  },
  pluginCard: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: space[3],
    padding: 14,
    borderRadius: radius.large,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: { default: colors.separator, ':hover': ACCENT_BORDER },
    backgroundColor: { default: colors.elevatedBackground, ':hover': SUBTLE_FILL },
    textAlign: 'left',
    cursor: 'pointer',
    transitionProperty: 'border-color, background-color, transform',
    transitionDuration: '140ms',
  },
  pluginCardDisabled: {
    borderColor: { default: colors.separator, ':hover': colors.separator },
    backgroundColor: { default: colors.elevatedBackground, ':hover': colors.elevatedBackground },
    opacity: 0.72,
    cursor: 'default',
  },
  pluginCardTop: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    gap: space[2],
  },
  logoTile: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 40,
    height: 40,
    borderRadius: radius.medium,
    backgroundColor: SUBTLE_FILL,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.separator,
    flexShrink: 0,
  },
  logoTileSmall: {
    width: 34,
    height: 34,
  },
  statusPill: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    height: 22,
    paddingInline: 8,
    borderRadius: radius.full,
    backgroundColor: SUBTLE_FILL,
    color: colors.secondaryLabel,
    fontSize: 11,
    fontWeight: 500,
  },
  statusPillConnected: {
    backgroundColor: SUCCESS_SOFT,
    color: colors.success,
  },
  statusPillWarn: {
    backgroundColor: WARNING_SOFT,
    color: colors.warning,
  },
  pluginCardBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    width: '100%',
  },
  pluginCardTitleRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    gap: space[2],
  },
  pluginCardTitle: {
    fontSize: text.bodySize,
    lineHeight: text.bodyLeading,
    fontWeight: 600,
    color: colors.label,
  },
  pluginCardDesc: {
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.secondaryLabel,
  },

  formStack: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[4],
  },
  fieldBlock: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[1.5],
  },
  fieldLabel: {
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    fontWeight: 600,
    color: colors.label,
  },
  fieldHint: {
    fontSize: 12,
    color: colors.secondaryLabel,
  },
  chipRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
  },
  selectChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    height: 28,
    paddingInline: 10,
    borderRadius: radius.full,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.separator,
    backgroundColor: { default: colors.elevatedBackground, ':hover': SUBTLE_HOVER },
    color: colors.secondaryLabel,
    fontSize: text.footnoteSize,
    cursor: 'pointer',
  },
  selectChipActive: {
    borderColor: ACCENT_BORDER,
    backgroundColor: { default: ACCENT_SOFT, ':hover': ACCENT_SOFT },
    color: colors.accent,
    fontWeight: 500,
  },
  templateChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    paddingBlock: 4,
    paddingInline: 9,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.separator,
    backgroundColor: { default: SUBTLE_FILL, ':hover': SUBTLE_HOVER },
    color: colors.secondaryLabel,
    fontSize: 11,
    cursor: 'pointer',
  },
  inlineSwitchRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[3],
    paddingBlock: 10,
    paddingInline: space[3],
    borderRadius: radius.medium,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.separator,
    backgroundColor: colors.elevatedBackground,
  },
  modeGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
    gap: 10,
  },
  modeCard: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 6,
    padding: space[3],
    borderRadius: radius.large,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.separator,
    backgroundColor: { default: colors.elevatedBackground, ':hover': SUBTLE_FILL },
    textAlign: 'left',
    cursor: 'pointer',
  },
  modeCardSelected: {
    borderColor: ACCENT_BORDER,
    backgroundColor: { default: ACCENT_SOFT, ':hover': ACCENT_SOFT },
  },
  modeCardHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    gap: space[2],
  },
  modeCardTitle: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: text.footnoteSize,
    fontWeight: 600,
    color: colors.label,
  },
  modeCardDesc: {
    fontSize: 12,
    lineHeight: '1.45',
    color: colors.secondaryLabel,
  },
  recurrenceBox: {
    padding: space[3],
    borderRadius: radius.large,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.separator,
    backgroundColor: colors.elevatedBackground,
  },
  footerBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: space[2],
    paddingBlock: space[3],
    paddingInline: space[4],
    borderTopWidth: 1,
    borderTopStyle: 'solid',
    borderTopColor: colors.separator,
    backgroundColor: colors.elevatedBackground,
    flexShrink: 0,
  },
});

export function ConnectorBrandLogo({
  pluginId,
  size = 20,
}: {
  pluginId: ConnectorPluginId;
  size?: number;
}) {
  switch (pluginId) {
    case 'schedule':
      return <CalendarClock size={size} style={{ color: '#6366F1' }} />;
    case 'github':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2Z" />
        </svg>
      );
    case 'linear':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="9.5" stroke="#5E6AD2" strokeWidth="2" />
          <path
            d="M4.8 14.8 9.2 19.2M3.6 10.7 13.3 20.4M6.2 6.2 17.8 17.8"
            stroke="#5E6AD2"
            strokeWidth="1.9"
            strokeLinecap="round"
          />
        </svg>
      );
    case 'slack':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="13" y="3" width="3.6" height="8.5" rx="1.8" fill="#2EB67D" />
          <circle cx="18.8" cy="9.7" r="1.8" fill="#2EB67D" />
          <rect x="12.5" y="13" width="8.5" height="3.6" rx="1.8" fill="#ECB22E" />
          <circle cx="14.3" cy="18.8" r="1.8" fill="#ECB22E" />
          <rect x="7.4" y="12.5" width="3.6" height="8.5" rx="1.8" fill="#E01E5A" />
          <circle cx="5.2" cy="14.3" r="1.8" fill="#E01E5A" />
          <rect x="3" y="7.4" width="8.5" height="3.6" rx="1.8" fill="#36C5F0" />
          <circle cx="9.7" cy="5.2" r="1.8" fill="#36C5F0" />
        </svg>
      );
    case 'gmail':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M3 7.2V18a1.8 1.8 0 0 0 1.8 1.8h2.2V10.6L12 14.3l5-3.7v9.2h2.2A1.8 1.8 0 0 0 21 18V7.2a2 2 0 0 0-3.2-1.6L12 9.9 6.2 5.6A2 2 0 0 0 3 7.2Z"
            fill="#EA4335"
          />
          <path d="M3 7.2V18a1.8 1.8 0 0 0 1.8 1.8H7V10.6L3 7.6V7.2Z" fill="#4285F4" />
          <path d="M21 7.2V18a1.8 1.8 0 0 1-1.8 1.8H17V10.6l4-3v-.4Z" fill="#34A853" />
        </svg>
      );
    case 'webhook':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="6.5" r="2.8" stroke="#F59E0B" strokeWidth="2" />
          <circle cx="6.8" cy="16.5" r="2.8" stroke="#F59E0B" strokeWidth="2" />
          <circle cx="17.2" cy="16.5" r="2.8" stroke="#F59E0B" strokeWidth="2" />
          <path
            d="M10.5 8.9 7.9 13.9M13.5 8.9l2.6 5M9.6 16.5h4.8"
            stroke="#F59E0B"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      );
  }
}

type DialogView =
  | { kind: 'hub' }
  | { kind: 'github'; editDoc?: CoordinatorTriggerDoc }
  | { kind: 'schedule' };

type UnifiedMountedItem =
  | {
      kind: 'connector';
      id: string;
      pluginId: ConnectorPluginId;
      title: string;
      summary: string;
      enabled: boolean;
      policyMode: CoordinatorTriggerPolicyMode;
      lastError?: string;
      doc: CoordinatorTriggerDoc;
    }
  | {
      kind: 'schedule';
      id: string;
      scheduleId: string;
      pluginId: 'schedule';
      title: string;
      summary: string;
      enabled: boolean;
      policyMode: CoordinatorTriggerPolicyMode;
      row: ScheduleRegistryRow;
    };

function CoordinatorTriggersDialog({
  open,
  onOpenChange,
  coordinatorSessionId,
  machineId,
  mountedItems,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  coordinatorSessionId: SessionId;
  machineId?: string;
  mountedItems: readonly UnifiedMountedItem[];
}) {
  const { t } = useTranslation();
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const currentUser = useAtomValue(userAtom);
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const coordinatorSession = useAtomValue(
    sessionMetaAtomFamily(getSessionRoomId(coordinatorSessionId))
  ) as SessionMeta | undefined;
  const agents = useAtomValue(getAllAgentConfigAtom);
  const { roles } = useWorkspaceAgentRoles();
  const machines = useAtomValue(getMachineMetaMapAtom);

  const [view, setView] = useState<DialogView>({ kind: 'hub' });
  const [connectorsStatus, setConnectorsStatus] =
    useState<CoordinatorConnectorStatusSummary | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // GitHub form state
  const [ghTitle, setGhTitle] = useState('');
  const [ghRepo, setGhRepo] = useState('');
  const [ghEvents, setGhEvents] = useState<GitHubTriggerEventKind[]>(['issue.opened']);
  const [ghLabels, setGhLabels] = useState('');
  const [ghExcludeBots, setGhExcludeBots] = useState(true);
  const [ghInstruction, setGhInstruction] = useState('');
  const [ghPolicyMode, setGhPolicyMode] =
    useState<CoordinatorTriggerPolicyMode>('summarize_and_notify');
  const [ghAllowedRoles, setGhAllowedRoles] = useState<string[]>([]);

  // Schedule form state
  const effectiveMachineId = (machineId ?? coordinatorSession?.machineId) as MachineId | undefined;
  const targetMachine = effectiveMachineId ? machines.get(effectiveMachineId) : undefined;
  const machineTimeZone = targetMachine?.timeZone ?? getDeviceTimeZone();
  const [schedTitle, setSchedTitle] = useState('');
  const [schedRecurrence, setSchedRecurrence] = useState<ScheduleRecurrence>(() =>
    defaultScheduleRecurrence(machineTimeZone)
  );
  const [schedPrompt, setSchedPrompt] = useState('');
  const [schedPolicyMode, setSchedPolicyMode] =
    useState<CoordinatorTriggerPolicyMode>('summarize_and_notify');

  const dispatchTriggerAction = useCallback(
    async (
      action: CoordinatorTriggerAction
    ): Promise<SessionCoordinatorTriggersResponse | null> => {
      if (!workspaceId || !effectiveMachineId) {
        toast.error(t('projectMode.triggers.daemonUnavailable', 'Local daemon unavailable'));
        return null;
      }
      const res = await sendLocalSessionControl({
        type: 'session/coordinator-triggers',
        machineId: effectiveMachineId,
        workspaceId: workspaceId as WorkspaceId,
        sessionId: coordinatorSessionId,
        action,
      });
      if (!res.ok) {
        toast.error(t('projectMode.triggers.saveError', 'Failed to save trigger'), {
          description: res.error,
        });
        return null;
      }
      const reply = res.responses.find(
        (item): item is SessionCoordinatorTriggersResponse =>
          item.type === 'session/coordinator-triggers_response'
      );
      if (!reply?.ok) {
        toast.error(t('projectMode.triggers.saveError', 'Failed to save trigger'), {
          description: reply?.error,
        });
        return null;
      }
      if (reply.connectors) {
        setConnectorsStatus(reply.connectors);
      }
      return reply;
    },
    [coordinatorSessionId, effectiveMachineId, t, workspaceId]
  );

  useEffect(() => {
    if (!open || !workspaceId || !effectiveMachineId) return;
    let cancelled = false;
    void sendLocalSessionControl({
      type: 'session/coordinator-triggers',
      machineId: effectiveMachineId,
      workspaceId: workspaceId as WorkspaceId,
      sessionId: coordinatorSessionId,
      action: { kind: 'status' },
    })
      .then((res) => {
        if (cancelled || !res.ok || !Array.isArray(res.responses)) return;
        const reply = res.responses.find(
          (item): item is SessionCoordinatorTriggersResponse =>
            item.type === 'session/coordinator-triggers_response'
        );
        if (reply?.connectors) setConnectorsStatus(reply.connectors);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [coordinatorSessionId, effectiveMachineId, open, workspaceId]);

  const openGitHubForm = useCallback(
    (editDoc?: CoordinatorTriggerDoc) => {
      if (editDoc) {
        const parsed = parseConnectorTriggerConfig(editDoc.configJson);
        setGhTitle(editDoc.title);
        setGhRepo(parsed?.pluginId === 'github' ? parsed.repoFullName : '');
        setGhEvents(parsed?.pluginId === 'github' ? [...parsed.events] : ['issue.opened']);
        setGhLabels(parsed?.pluginId === 'github' && parsed.labels ? parsed.labels.join(', ') : '');
        setGhExcludeBots(parsed?.pluginId === 'github' ? parsed.excludeBots : true);
        setGhInstruction(editDoc.instruction);
        setGhPolicyMode(editDoc.policyMode);
        setGhAllowedRoles(editDoc.allowedRoleIds ? [...editDoc.allowedRoleIds] : []);
      } else {
        const defaultRepo = connectorsStatus?.github.suggestedRepos[0] ?? '';
        setGhTitle('');
        setGhRepo(defaultRepo);
        setGhEvents(['issue.opened']);
        setGhLabels('');
        setGhExcludeBots(true);
        setGhInstruction(
          t(
            'projectMode.triggers.github.defaultInstruction',
            'When new matching GitHub activity arrives, summarize the key points, impact, and suggested next step for me.'
          )
        );
        setGhPolicyMode('summarize_and_notify');
        setGhAllowedRoles([]);
      }
      setView({ kind: 'github', editDoc });
    },
    [connectorsStatus?.github.suggestedRepos, t]
  );

  const openScheduleForm = useCallback(() => {
    setSchedTitle('');
    setSchedRecurrence(defaultScheduleRecurrence(machineTimeZone));
    setSchedPrompt(
      t(
        'projectMode.triggers.schedule.defaultPrompt',
        'Review current project tasks and open pull requests, and send me a concise progress summary.'
      )
    );
    setSchedPolicyMode('summarize_and_notify');
    setView({ kind: 'schedule' });
  }, [machineTimeZone, t]);

  const handleSelectPlugin = (plugin: ConnectorPluginManifest) => {
    if (plugin.status !== 'available') return;
    if (plugin.id === 'github') {
      openGitHubForm();
      return;
    }
    if (plugin.id === 'schedule') {
      openScheduleForm();
    }
  };

  const toggleGitHubEvent = (eventKind: GitHubTriggerEventKind) => {
    setGhEvents((prev) =>
      prev.includes(eventKind)
        ? prev.length > 1
          ? prev.filter((item) => item !== eventKind)
          : prev
        : [...prev, eventKind]
    );
  };

  const handleSaveGitHub = async () => {
    const repo = ghRepo.trim();
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
      toast.error(
        t('projectMode.triggers.github.invalidRepo', 'Enter a repository in owner/repo format.')
      );
      return;
    }
    if (!ghInstruction.trim()) {
      toast.error(
        t('projectMode.triggers.requireInstruction', 'Describe what the coordinator should do.')
      );
      return;
    }
    const labels = ghLabels
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    const title =
      ghTitle.trim() || `${t('projectMode.triggers.plugins.github.title', 'GitHub')} · ${repo}`;

    setSaving(true);
    try {
      const editDoc = view.kind === 'github' ? view.editDoc : undefined;
      const reply = await dispatchTriggerAction({
        kind: 'upsert',
        payload: {
          ...(editDoc ? { triggerId: editDoc.id } : {}),
          title,
          enabled: editDoc ? editDoc.enabled : true,
          config: {
            pluginId: 'github',
            repoFullName: repo,
            events: ghEvents,
            ...(labels.length > 0 ? { labels } : {}),
            excludeBots: ghExcludeBots,
            pollIntervalSec: 60,
          },
          instruction: ghInstruction.trim(),
          policy: {
            mode: ghPolicyMode,
            ...(ghPolicyMode === 'auto_delegate' && ghAllowedRoles.length > 0
              ? { allowedRoleIds: ghAllowedRoles }
              : {}),
            maxChildrenPerRun: 2,
          },
        },
      });
      if (reply) {
        toast.success(
          t('projectMode.triggers.enabledToast', 'Trigger “{{title}}” enabled', { title })
        );
        setView({ kind: 'hub' });
      }
    } finally {
      setSaving(false);
    }
  };

  const handleSaveSchedule = async () => {
    if (!runtime || !currentUser || !coordinatorSession) {
      toast.error(t('projectMode.triggers.daemonUnavailable', 'Local daemon unavailable'));
      return;
    }
    const cleanTitle =
      schedTitle.trim() || t('projectMode.triggers.schedule.defaultTitle', 'Coordinator Check-in');
    const cleanPrompt = schedPrompt.trim();
    if (!cleanPrompt) {
      toast.error(
        t('projectMode.triggers.requireInstruction', 'Describe what the coordinator should do.')
      );
      return;
    }
    setSaving(true);
    try {
      const history = await runtime.withSessionStore(coordinatorSessionId, (store) =>
        readSessionHistoryMetadata(store.sessionData.history)
      );
      const runConfig = resolveSessionConversationConfig(history);
      const scheduleId = uuid();
      const now = getServerNow();
      const trigger = applyScheduleRecurrence(
        withScheduleRecurrenceTimeZone(schedRecurrence, machineTimeZone),
        now
      );
      const resolved = resolveScheduleProposalTarget({
        meta: {
          proposalId: scheduleId,
          title: cleanTitle,
          prompt: cleanPrompt,
          rule: { kind: 'daily', hour: 9, minute: 0 },
          destination: { kind: 'existing_session', sessionId: coordinatorSessionId },
        },
        conversation: {
          session: coordinatorSession,
          runConfig: {
            modeId: runConfig.modeId,
            modelId: runConfig.modelId,
            configOptionValues: runConfig.configOptionValues,
          },
        },
        agents,
        roles,
      });
      if (!resolved.ok) {
        toast.error(t('schedules.saveError', 'The schedule could not be saved.'));
        return;
      }
      const { ScheduleRepository } = await import('@lody/shared/schedule-repository');
      await runtime.withScheduleStore(
        scheduleId,
        () =>
          new ScheduleRepository(runtime.repo, runtime.workspaceId, {
            protectedContent: runtime.contentMode === 'e2ee',
            signDeclaration: runtime.signScheduleDeclaration,
          }).save({
            scheduleId,
            activationId: uuid(),
            activityId: `coord-trigger-${scheduleId}`,
            actorId: currentUser.id,
            now,
            create: true,
            draft: {
              title: cleanTitle,
              prompt: cleanPrompt,
              trigger,
              machineId: resolved.target.agentConfig.machineId,
              agent: resolved.target.agent,
              ...(resolved.target.project ? { project: resolved.target.project } : {}),
              destination: { kind: 'existing_session', sessionId: coordinatorSessionId },
              misfirePolicy: { kind: 'run_once' },
              overlapPolicy: 'queue_one',
              retryPolicy: { dispatchMaxAttempts: 5, dispatchMaxAgeMs: 86_400_000 },
            },
          }),
        { create: true }
      );
      if (schedPolicyMode === 'auto_delegate') {
        await dispatchTriggerAction({
          kind: 'set_policy',
          triggerId: schedulePolicyTriggerId(scheduleId),
          scheduleId,
          title: cleanTitle,
          policy: { mode: 'auto_delegate', maxChildrenPerRun: 2 },
        });
      }
      toast.success(
        t('projectMode.triggers.enabledToast', 'Trigger “{{title}}” enabled', { title: cleanTitle })
      );
      setView({ kind: 'hub' });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const handleToggleItem = async (item: UnifiedMountedItem) => {
    setBusyId(item.id);
    try {
      if (item.kind === 'connector') {
        await dispatchTriggerAction({
          kind: 'toggle',
          triggerId: item.id,
          enabled: !item.enabled,
        });
      } else if (runtime && currentUser) {
        const { ScheduleRepository } = await import('@lody/shared/schedule-repository');
        const repo = new ScheduleRepository(runtime.repo, runtime.workspaceId, {
          protectedContent: runtime.contentMode === 'e2ee',
          signDeclaration: runtime.signScheduleDeclaration,
        });
        await runtime.withScheduleStore(item.scheduleId, () =>
          repo.setEnabled({
            scheduleId: item.scheduleId,
            enabled: !item.enabled,
            actorId: currentUser.id,
            now: getServerNow(),
            activationId: uuid(),
            requestId: uuid(),
          })
        );
      }
    } finally {
      setBusyId(null);
    }
  };

  const handleFlipPolicy = async (item: UnifiedMountedItem) => {
    const nextMode: CoordinatorTriggerPolicyMode =
      item.policyMode === 'auto_delegate' ? 'summarize_and_notify' : 'auto_delegate';
    setBusyId(item.id);
    try {
      await dispatchTriggerAction({
        kind: 'set_policy',
        triggerId: item.id,
        ...(item.kind === 'schedule' ? { scheduleId: item.scheduleId, title: item.title } : {}),
        policy: {
          mode: nextMode,
          ...(item.kind === 'connector' && item.doc.allowedRoleIds?.length
            ? { allowedRoleIds: item.doc.allowedRoleIds }
            : {}),
          maxChildrenPerRun: 2,
        },
      });
    } finally {
      setBusyId(null);
    }
  };

  const handleRunNow = async (item: UnifiedMountedItem) => {
    setBusyId(item.id);
    try {
      if (item.kind === 'connector') {
        const reply = await dispatchTriggerAction({ kind: 'run_now', triggerId: item.id });
        if (reply) {
          toast.success(
            t('projectMode.triggers.checkedToast', 'Checked “{{title}}” for new events', {
              title: item.title,
            })
          );
        }
      } else if (runtime && currentUser) {
        const { ScheduleRepository } = await import('@lody/shared/schedule-repository');
        const repo = new ScheduleRepository(runtime.repo, runtime.workspaceId, {
          protectedContent: runtime.contentMode === 'e2ee',
          signDeclaration: runtime.signScheduleDeclaration,
        });
        await runtime.withScheduleStore(item.scheduleId, () =>
          repo.requestRun({
            scheduleId: item.scheduleId,
            actorId: currentUser.id,
            manualRunId: uuid(),
            now: getServerNow(),
          })
        );
        toast.success(
          t('schedules.runStarted', 'Run requested for “{{title}}”.', { title: item.title })
        );
      }
    } finally {
      setBusyId(null);
    }
  };

  const handleDeleteItem = async (item: UnifiedMountedItem) => {
    setBusyId(item.id);
    try {
      if (item.kind === 'connector') {
        await dispatchTriggerAction({ kind: 'delete', triggerId: item.id });
      } else if (runtime && currentUser) {
        const { ScheduleRepository } = await import('@lody/shared/schedule-repository');
        const repo = new ScheduleRepository(runtime.repo, runtime.workspaceId, {
          protectedContent: runtime.contentMode === 'e2ee',
          signDeclaration: runtime.signScheduleDeclaration,
        });
        await runtime.withScheduleStore(item.scheduleId, () =>
          repo.delete(item.scheduleId, currentUser.id, getServerNow())
        );
        await dispatchTriggerAction({ kind: 'delete', triggerId: item.id });
      }
    } finally {
      setBusyId(null);
    }
  };

  const eventLabels: Record<GitHubTriggerEventKind, string> = {
    'issue.opened': t('projectMode.triggers.github.events.issueOpened', 'New Issue'),
    'issue.commented': t('projectMode.triggers.github.events.issueCommented', 'Issue Comment'),
    'pr.opened': t('projectMode.triggers.github.events.prOpened', 'New Pull Request'),
    'pr.review_requested': t(
      'projectMode.triggers.github.events.prReviewRequested',
      'Review Requested'
    ),
    'workflow_run.failed': t('projectMode.triggers.github.events.workflowFailed', 'CI Failed'),
    'release.published': t(
      'projectMode.triggers.github.events.releasePublished',
      'Release Published'
    ),
  };

  const renderPermissionModeCards = (
    selected: CoordinatorTriggerPolicyMode,
    onSelect: (next: CoordinatorTriggerPolicyMode) => void
  ) => (
    <div {...stylex.props(styles.fieldBlock)}>
      <span {...stylex.props(styles.fieldLabel)}>
        {t('projectMode.triggers.policy.label', 'Execution & Delegation Policy')}
      </span>
      <div {...stylex.props(styles.modeGrid)}>
        <button
          type="button"
          onClick={() => onSelect('summarize_and_notify')}
          {...stylex.props(
            styles.modeCard,
            selected === 'summarize_and_notify' && styles.modeCardSelected
          )}
        >
          <div {...stylex.props(styles.modeCardHeader)}>
            <span {...stylex.props(styles.modeCardTitle)}>
              <Bell size={14} />
              {t('projectMode.triggers.policy.notifyTitle', 'Summarize & Notify Only')}
            </span>
            {selected === 'summarize_and_notify' ? <Check size={14} /> : null}
          </div>
          <span {...stylex.props(styles.modeCardDesc)}>
            {t(
              'projectMode.triggers.policy.notifyDesc',
              'Default. Coordinator summarizes the update without automatically creating child conversations; offers a 1-click card when action is needed.'
            )}
          </span>
        </button>

        <button
          type="button"
          onClick={() => onSelect('auto_delegate')}
          {...stylex.props(
            styles.modeCard,
            selected === 'auto_delegate' && styles.modeCardSelected
          )}
        >
          <div {...stylex.props(styles.modeCardHeader)}>
            <span {...stylex.props(styles.modeCardTitle)}>
              <Sparkles size={14} />
              {t('projectMode.triggers.policy.delegateTitle', 'Allow Auto-Creating Child Tasks')}
            </span>
            {selected === 'auto_delegate' ? <Check size={14} /> : null}
          </div>
          <span {...stylex.props(styles.modeCardDesc)}>
            {t(
              'projectMode.triggers.policy.delegateDesc',
              'Allows the coordinator to automatically spawn child conversations (up to 2 per wake) when your instruction criteria are met.'
            )}
          </span>
        </button>
      </div>
    </div>
  );

  const renderPluginStatusBadge = (plugin: ConnectorPluginManifest) => {
    if (plugin.status === 'coming_soon') {
      return (
        <span {...stylex.props(styles.statusPill)}>
          {t('projectMode.triggers.status.comingSoon', 'Coming soon')}
        </span>
      );
    }
    if (plugin.id === 'schedule') {
      return (
        <span {...stylex.props(styles.statusPill, styles.statusPillConnected)}>
          {t('projectMode.triggers.status.builtin', 'Built-in')}
        </span>
      );
    }
    if (plugin.id === 'github') {
      const gh = connectorsStatus?.github;
      if (!gh) return null;
      if (gh.status === 'connected' || gh.status === 'local_cli') {
        return (
          <span {...stylex.props(styles.statusPill, styles.statusPillConnected)}>
            {gh.source === 'gh'
              ? t('projectMode.triggers.status.ghCli', 'GitHub CLI')
              : t('projectMode.triggers.status.connected', 'Connected')}
          </span>
        );
      }
      return (
        <span {...stylex.props(styles.statusPill, styles.statusPillWarn)}>
          {t('projectMode.triggers.status.needsAuth', 'Sign in required')}
        </span>
      );
    }
    return null;
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content
        width="min(860px, 94vw)"
        padding="none"
        gap="none"
        data-testid="coordinator-triggers-dialog"
      >
        <div {...stylex.props(styles.shell)}>
          <div {...stylex.props(styles.topBar)}>
            <div {...stylex.props(styles.topTitleRow)}>
              {view.kind !== 'hub' ? (
                <button
                  type="button"
                  onClick={() => setView({ kind: 'hub' })}
                  aria-label={t('projectMode.triggers.backToHub', 'Back to integrations')}
                  {...stylex.props(styles.backBtn)}
                >
                  <ArrowLeft size={15} />
                </button>
              ) : (
                <span {...stylex.props(styles.topBadge)}>
                  <Zap size={16} />
                </span>
              )}
              <div {...stylex.props(styles.titleStack)}>
                <Dialog.Title xstyle={styles.titleMain}>
                  {view.kind === 'github'
                    ? view.editDoc
                      ? t('projectMode.triggers.github.editTitle', 'Edit GitHub Monitor')
                      : t('projectMode.triggers.github.newTitle', 'Add GitHub Event Trigger')
                    : view.kind === 'schedule'
                      ? t('projectMode.triggers.schedule.newTitle', 'Add Recurring Schedule')
                      : t('projectMode.triggers.hubTitle', 'Coordinator Triggers & Integrations')}
                </Dialog.Title>
                <Dialog.Description xstyle={styles.titleSub}>
                  {view.kind === 'hub'
                    ? t(
                        'projectMode.triggers.hubSubtitle',
                        'Connect schedules and external event monitors to wake this coordinator. Triggers summarize & notify by default unless you grant child-session delegation.'
                      )
                    : t(
                        'projectMode.triggers.formSubtitle',
                        'Configure trigger conditions, coordinator instructions, and child-session delegation policy.'
                      )}
                </Dialog.Description>
              </div>
            </div>
          </div>

          <div {...stylex.props(styles.bodyScroll)}>
            {view.kind === 'hub' ? (
              <>
                <div {...stylex.props(styles.section)}>
                  <div {...stylex.props(styles.sectionHeader)}>
                    <span {...stylex.props(styles.sectionTitle)}>
                      {t('projectMode.triggers.mountedSection', 'Mounted on This Coordinator')} (
                      {mountedItems.length})
                    </span>
                  </div>
                  {mountedItems.length === 0 ? (
                    <div {...stylex.props(styles.emptyMountedBox)}>
                      <Zap size={15} />
                      <span>
                        {t(
                          'projectMode.triggers.emptyMounted',
                          'No triggers mounted yet. Pick an integration card below or tell the coordinator in chat what to monitor.'
                        )}
                      </span>
                    </div>
                  ) : (
                    <div {...stylex.props(styles.mountedList)}>
                      {mountedItems.map((item) => {
                        const isBusy = busyId === item.id;
                        const isDelegate = item.policyMode === 'auto_delegate';
                        return (
                          <div
                            key={item.id}
                            data-testid={`mounted-trigger-${item.id}`}
                            {...stylex.props(
                              styles.mountedRow,
                              !item.enabled && styles.mountedRowPaused
                            )}
                          >
                            <div {...stylex.props(styles.mountedLeft)}>
                              <span {...stylex.props(styles.logoTile, styles.logoTileSmall)}>
                                <ConnectorBrandLogo pluginId={item.pluginId} size={18} />
                              </span>
                              <div {...stylex.props(styles.mountedText)}>
                                <div {...stylex.props(styles.mountedTitleRow)}>
                                  <span {...stylex.props(styles.mountedTitle)}>{item.title}</span>
                                </div>
                                <span {...stylex.props(styles.mountedSummary)}>{item.summary}</span>
                                {item.kind === 'connector' && item.lastError ? (
                                  <span {...stylex.props(styles.mountedError)}>
                                    <AlertCircle size={11} />
                                    {item.lastError}
                                  </span>
                                ) : null}
                              </div>
                            </div>

                            <div {...stylex.props(styles.mountedActions)}>
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => void handleFlipPolicy(item)}
                                title={t(
                                  'projectMode.triggers.policy.clickToSwitch',
                                  'Click to switch between Notify Only and Auto-Delegate'
                                )}
                                {...stylex.props(
                                  styles.policyChip,
                                  isDelegate && styles.policyChipDelegate
                                )}
                              >
                                {isDelegate ? <Sparkles size={11} /> : <Bell size={11} />}
                                {isDelegate
                                  ? t('projectMode.triggers.policy.badgeDelegate', 'Auto-delegate')
                                  : t('projectMode.triggers.policy.badgeNotify', 'Notify only')}
                              </button>

                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => void handleRunNow(item)}
                                title={
                                  item.kind === 'connector'
                                    ? t('projectMode.triggers.checkNow', 'Check now')
                                    : t('projectMode.triggers.runNow', 'Run now')
                                }
                                {...stylex.props(styles.iconActionBtn)}
                              >
                                {item.kind === 'connector' ? (
                                  <RefreshCw size={14} />
                                ) : (
                                  <Play size={14} />
                                )}
                              </button>

                              {item.kind === 'connector' && item.pluginId === 'github' ? (
                                <button
                                  type="button"
                                  disabled={isBusy}
                                  onClick={() => openGitHubForm(item.doc)}
                                  title={t('common.edit', 'Edit')}
                                  {...stylex.props(styles.iconActionBtn)}
                                >
                                  <Pencil size={14} />
                                </button>
                              ) : null}

                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => void handleDeleteItem(item)}
                                title={t('common.delete', 'Delete')}
                                {...stylex.props(styles.iconActionBtn, styles.iconActionDanger)}
                              >
                                <Trash2 size={14} />
                              </button>

                              <Switch
                                checked={item.enabled}
                                disabled={isBusy}
                                onCheckedChange={() => void handleToggleItem(item)}
                                aria-label={item.title}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div {...stylex.props(styles.section)}>
                  <div {...stylex.props(styles.sectionHeader)}>
                    <span {...stylex.props(styles.sectionTitle)}>
                      {t('projectMode.triggers.catalogSection', 'Add Trigger or Integration')}
                    </span>
                  </div>

                  <div {...stylex.props(styles.cardGrid)} data-testid="connector-plugin-grid">
                    {CONNECTOR_PLUGIN_CATALOG.map((plugin) => {
                      const available = plugin.status === 'available';
                      return (
                        <button
                          key={plugin.id}
                          type="button"
                          disabled={!available}
                          data-connector-card={plugin.id}
                          onClick={() => handleSelectPlugin(plugin)}
                          {...stylex.props(
                            styles.pluginCard,
                            !available && styles.pluginCardDisabled
                          )}
                        >
                          <div {...stylex.props(styles.pluginCardTop)}>
                            <span {...stylex.props(styles.logoTile)}>
                              <ConnectorBrandLogo pluginId={plugin.id} size={22} />
                            </span>
                            {renderPluginStatusBadge(plugin)}
                          </div>
                          <div {...stylex.props(styles.pluginCardBody)}>
                            <div {...stylex.props(styles.pluginCardTitleRow)}>
                              <span {...stylex.props(styles.pluginCardTitle)}>
                                {t(plugin.titleKey, plugin.defaultTitle)}
                              </span>
                              {available ? <Plus size={14} /> : null}
                            </div>
                            <span {...stylex.props(styles.pluginCardDesc)}>
                              {t(plugin.descriptionKey, plugin.defaultDescription)}
                            </span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </>
            ) : view.kind === 'github' ? (
              <div {...stylex.props(styles.formStack)}>
                <div {...stylex.props(styles.fieldBlock)}>
                  <span {...stylex.props(styles.fieldLabel)}>
                    {t('projectMode.triggers.github.repoLabel', 'GitHub Repository')}
                  </span>
                  <Input
                    value={ghRepo}
                    onChange={(event) => setGhRepo(event.target.value)}
                    placeholder="owner/repo"
                  />
                  {connectorsStatus?.github.suggestedRepos.length ? (
                    <div {...stylex.props(styles.chipRow)}>
                      {connectorsStatus.github.suggestedRepos.map((repo) => (
                        <button
                          key={repo}
                          type="button"
                          onClick={() => setGhRepo(repo)}
                          {...stylex.props(
                            styles.selectChip,
                            ghRepo.trim() === repo && styles.selectChipActive
                          )}
                        >
                          {repo}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>

                <div {...stylex.props(styles.fieldBlock)}>
                  <span {...stylex.props(styles.fieldLabel)}>
                    {t('projectMode.triggers.github.eventsLabel', 'Events to Monitor')}
                  </span>
                  <div {...stylex.props(styles.chipRow)}>
                    {GITHUB_TRIGGER_EVENT_KINDS.map((kind) => {
                      const active = ghEvents.includes(kind);
                      return (
                        <button
                          key={kind}
                          type="button"
                          onClick={() => toggleGitHubEvent(kind)}
                          {...stylex.props(styles.selectChip, active && styles.selectChipActive)}
                        >
                          {active ? <Check size={12} /> : null}
                          {eventLabels[kind]}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div {...stylex.props(styles.fieldBlock)}>
                  <span {...stylex.props(styles.fieldLabel)}>
                    {t('projectMode.triggers.titleLabel', 'Trigger Name (Optional)')}
                  </span>
                  <Input
                    value={ghTitle}
                    onChange={(event) => setGhTitle(event.target.value)}
                    placeholder={
                      ghRepo.trim() ? `GitHub · ${ghRepo.trim()}` : 'GitHub Issue Monitor'
                    }
                  />
                </div>

                <div {...stylex.props(styles.fieldBlock)}>
                  <span {...stylex.props(styles.fieldLabel)}>
                    {t('projectMode.triggers.github.labelsFilter', 'Filter by Labels (Optional)')}
                  </span>
                  <Input
                    value={ghLabels}
                    onChange={(event) => setGhLabels(event.target.value)}
                    placeholder={t(
                      'projectMode.triggers.github.labelsPlaceholder',
                      'e.g. bug, regression, priority:high'
                    )}
                  />
                </div>

                <div {...stylex.props(styles.inlineSwitchRow)}>
                  <div {...stylex.props(styles.titleStack)}>
                    <span {...stylex.props(styles.fieldLabel)}>
                      {t('projectMode.triggers.github.excludeBots', 'Ignore Bot Accounts')}
                    </span>
                    <span {...stylex.props(styles.fieldHint)}>
                      {t(
                        'projectMode.triggers.github.excludeBotsHint',
                        'Skips noisy automated comments and PRs from dependabot, github-actions, etc.'
                      )}
                    </span>
                  </div>
                  <Switch
                    checked={ghExcludeBots}
                    onCheckedChange={(checked) => setGhExcludeBots(checked)}
                  />
                </div>

                <div {...stylex.props(styles.fieldBlock)}>
                  <span {...stylex.props(styles.fieldLabel)}>
                    {t('projectMode.triggers.instructionLabel', 'Coordinator Instruction')}
                  </span>
                  <div {...stylex.props(styles.chipRow)}>
                    <button
                      type="button"
                      onClick={() =>
                        setGhInstruction(
                          t(
                            'projectMode.triggers.github.tplSummarizeIssue',
                            'Summarize each new Issue concisely (problem, impact area, urgency) and ask if I want to spin up a child conversation.'
                          )
                        )
                      }
                      {...stylex.props(styles.templateChip)}
                    >
                      {t('projectMode.triggers.github.tplChipIssue', 'Summarize new Issues')}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setGhInstruction(
                          t(
                            'projectMode.triggers.github.tplCiFail',
                            'When CI fails, summarize the failing workflow and likely cause, and offer a one-click action to investigate.'
                          )
                        )
                      }
                      {...stylex.props(styles.templateChip)}
                    >
                      {t('projectMode.triggers.github.tplChipCi', 'Triage CI failures')}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setGhInstruction(
                          t(
                            'projectMode.triggers.github.tplPrReview',
                            'Summarize newly opened or review-requested Pull Requests with key changes and risk areas.'
                          )
                        )
                      }
                      {...stylex.props(styles.templateChip)}
                    >
                      {t('projectMode.triggers.github.tplChipPr', 'Summarize PR reviews')}
                    </button>
                  </div>
                  <Textarea
                    rows={3}
                    value={ghInstruction}
                    onChange={(event) => setGhInstruction(event.target.value)}
                  />
                </div>

                {renderPermissionModeCards(ghPolicyMode, setGhPolicyMode)}

                {ghPolicyMode === 'auto_delegate' && roles.length > 0 ? (
                  <div {...stylex.props(styles.fieldBlock)}>
                    <span {...stylex.props(styles.fieldLabel)}>
                      {t(
                        'projectMode.triggers.policy.allowedRolesLabel',
                        'Restrict Auto-Delegated Agent Roles (Optional)'
                      )}
                    </span>
                    <div {...stylex.props(styles.chipRow)}>
                      {roles.map((role) => {
                        const selected = ghAllowedRoles.includes(role.id);
                        return (
                          <button
                            key={role.id}
                            type="button"
                            onClick={() =>
                              setGhAllowedRoles((prev) =>
                                prev.includes(role.id)
                                  ? prev.filter((id) => id !== role.id)
                                  : [...prev, role.id]
                              )
                            }
                            {...stylex.props(
                              styles.selectChip,
                              selected && styles.selectChipActive
                            )}
                          >
                            {selected ? <Check size={12} /> : null}
                            {role.name}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : (
              <div {...stylex.props(styles.formStack)}>
                <div {...stylex.props(styles.fieldBlock)}>
                  <span {...stylex.props(styles.fieldLabel)}>
                    {t('projectMode.triggers.titleLabel', 'Trigger Name (Optional)')}
                  </span>
                  <Input
                    value={schedTitle}
                    onChange={(event) => setSchedTitle(event.target.value)}
                    placeholder={t(
                      'projectMode.triggers.schedule.defaultTitle',
                      'Coordinator Check-in'
                    )}
                  />
                </div>

                <div {...stylex.props(styles.recurrenceBox)}>
                  <ScheduleRecurrenceEditor
                    value={schedRecurrence}
                    onChange={setSchedRecurrence}
                    now={getServerNow()}
                    timeZone={machineTimeZone}
                  />
                </div>

                <div {...stylex.props(styles.fieldBlock)}>
                  <span {...stylex.props(styles.fieldLabel)}>
                    {t('projectMode.triggers.instructionLabel', 'Coordinator Instruction')}
                  </span>
                  <Textarea
                    rows={3}
                    value={schedPrompt}
                    onChange={(event) => setSchedPrompt(event.target.value)}
                  />
                </div>

                {renderPermissionModeCards(schedPolicyMode, setSchedPolicyMode)}
              </div>
            )}
          </div>

          {view.kind !== 'hub' ? (
            <div {...stylex.props(styles.footerBar)}>
              <Button variant="ghost" onClick={() => setView({ kind: 'hub' })} disabled={saving}>
                {t('common.cancel', 'Cancel')}
              </Button>
              <Button
                variant="primary"
                disabled={saving}
                onClick={() =>
                  void (view.kind === 'github' ? handleSaveGitHub() : handleSaveSchedule())
                }
              >
                {saving
                  ? t('common.saving', 'Saving…')
                  : t('projectMode.triggers.saveAndEnable', 'Save & Enable')}
              </Button>
            </div>
          ) : null}
        </div>
      </Dialog.Content>
    </Dialog.Root>
  );
}

/**
 * Header trigger button inside every Project Coordinator conversation toolbar.
 * Opens the Integrations & Triggers Hub with active triggers and rounded brand cards.
 */
export function CoordinatorTriggersHeaderButton({
  coordinatorSessionId,
  machineId,
}: {
  coordinatorSessionId: SessionId;
  machineId?: string;
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const { doc: coordinatorDoc } = useSessionDoc(coordinatorSessionId, { syncEnabled: false });
  const schedules = useSchedules();

  const mountedItems = useMemo<UnifiedMountedItem[]>(() => {
    const triggersMap = normalizeCoordinatorTriggersMap(coordinatorDoc.triggers);
    const items: UnifiedMountedItem[] = [];

    for (const doc of Object.values(triggersMap)) {
      if (doc.pluginId === 'schedule' || doc.id.startsWith('sched:')) continue;
      items.push({
        kind: 'connector',
        id: doc.id,
        pluginId: doc.pluginId,
        title: doc.title,
        summary: doc.summary ?? doc.instruction,
        enabled: doc.enabled,
        policyMode: doc.policyMode,
        lastError: doc.lastError,
        doc,
      });
    }

    for (const row of schedules.rows) {
      if (
        row.destination.kind === 'existing_session' &&
        row.destination.sessionId === coordinatorSessionId &&
        !row.scheduledMessage
      ) {
        const policyDoc = triggersMap[schedulePolicyTriggerId(row.scheduleId)];
        items.push({
          kind: 'schedule',
          id: schedulePolicyTriggerId(row.scheduleId),
          scheduleId: row.scheduleId,
          pluginId: 'schedule',
          title: row.title,
          summary: describeTrigger(row.trigger, t, i18n.language),
          enabled: row.enabled,
          policyMode: policyDoc?.policyMode ?? 'summarize_and_notify',
          row,
        });
      }
    }

    return items;
  }, [coordinatorDoc.triggers, coordinatorSessionId, i18n.language, schedules.rows, t]);

  const activeCount = useMemo(
    () => mountedItems.filter((item) => item.enabled).length,
    [mountedItems]
  );

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-coordinator-triggers-button=""
        title={t(
          'projectMode.triggers.headerTooltip',
          'Add schedules, GitHub monitors, and external event triggers to this coordinator'
        )}
        {...stylex.props(styles.headerBtn, open && styles.headerBtnActive)}
      >
        {activeCount > 0 ? <span {...stylex.props(styles.headerDot)} /> : null}
        <Zap size={13} aria-hidden="true" />
        <span>{t('projectMode.triggers.headerLabel', 'Triggers')}</span>
        {mountedItems.length > 0 ? (
          <span {...stylex.props(styles.headerCount)}>{mountedItems.length}</span>
        ) : null}
      </button>

      {open ? (
        <CoordinatorTriggersDialog
          open={open}
          onOpenChange={setOpen}
          coordinatorSessionId={coordinatorSessionId}
          machineId={machineId}
          mountedItems={mountedItems}
        />
      ) : null}
    </>
  );
}

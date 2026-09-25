import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAtomValue, useSetAtom } from 'jotai';
import { motion, AnimatePresence } from 'framer-motion';
import * as stylex from '@stylexjs/stylex';
import { CheckCircle2, ChevronDown, ChevronUp, Copy, Plus, Trash2, XCircle } from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
import {
  REGISTRY_ACP_AGENTS,
  getBuiltinAgentByAgentType,
  isManagedBuiltinAgentType,
  type AgentBrandId,
  type BuiltinAgentType,
  type ManagedBuiltinAgentType,
  type AgentConfigId,
  type AgentConfigMeta,
  type MachineId,
  type MachineAcpBinaryProgressMessage,
  type MachineViewMeta,
  type ProviderSetupTask,
} from '@lody/shared';
import { toast } from '@/lib/toast';
import { Button } from '@lody/ui/button';
import { Badge } from '@lody/ui/badge';
import { Tooltip } from '@lody/ui/tooltip';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { corner, duration, ease, focus, radius, space } from '@lody/ui/tokens/scales.stylex';
import { AlertDialog } from '@/ui/dialog';
import { withClassName } from '@/lib/stylex';
import {
  cmdCreateAgentConfigAtom,
  cmdCreateProviderSetupAtom,
  cmdRetryProviderSetupAtom,
  cmdUpdateAgentConfigAtom,
  deleteAgentConfigAtom,
  deleteProviderSetupAtom,
  getAllAgentConfigAtom,
  getAllProviderSetupsAtom,
} from '@/atoms/agents';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { currentWorkspaceIdAtom } from '@/atoms/workspace-context';
import { localMachineIdAtom, localProbeAttemptedAtom } from '@/atoms/local-probe';
import type { DesktopOnboardingProviderSelection } from '@/atoms/onboarding';
import { useVisibleMachineMetas } from '@/hooks/use-visible-machine-metas';
import { useMachineFlockAgentConfigsForMachineIds } from '@/hooks/use-machine-flock-agent-configs';
import { resyncMachineFlockRows } from '@/hooks/use-machine-flock-rows';
import { useMachineAcpBinaryActions } from '@/hooks/use-machine-acp-binary-actions';
import { useProviderSetupRuntimeProgress } from '@/hooks/use-provider-setup-runtime-progress';
import { AgentIcon } from '@/components/icons/agent-icon';
import { AgentReadinessMark } from '@/components/shared/agent-readiness-mark';
import { REGISTRY_AGENT_ICON_SVGS } from '@/components/icons/registry-agent-icons';
import {
  AgentConfigDialog,
  buildPresetCreateForm,
  GLM_CLAUDE_PRESET_ID,
  MIMO_CLAUDE_PRESET_ID,
  MINIMAX_CLAUDE_PRESET_ID,
  type AgentConfigDialogMode,
  type AgentConfigSubmitPayload,
} from '@/components/settings/agent-config-dialog';
import { labelForAgent } from '@/components/settings/provider-row';
import { getIpcServices } from '@/lib/electron-ipc-client';
import { ProviderSetupRow } from '@/components/settings/provider-setup-row';
import { ProviderProgressButton } from '@/components/settings/provider-progress-button';
import { AcpAuthenticationPanel } from '@/components/settings/acp-authentication-panel';
import { OnboardingShell, OnboardingBackButton, OnboardingNextButton } from '../onboarding-shell';
import type { TourConfigurationState } from '../tour/tour-app';
import {
  resolveInitialOnboardingProviderStatus,
  type OnboardingProviderStatus,
} from '../provider-status';
import { collectErrorBoundaryEnvironment } from '@/lib/error-boundary-report';
import { writeTextToClipboard } from '@/lib/clipboard';
import { buildProviderWaitReport } from '../provider-wait-report';
import {
  agentRuntimeReadinessFromActivity,
  createProviderTestRunRegistry,
  providerTestActivityFromProgress,
  providerWaitEscalation,
  type AgentRuntimeReadiness,
  type ProviderTestActivity,
  type ProviderWaitEscalation,
} from '../provider-test-state';
import { useBuiltinRuntimeReadiness } from '../use-builtin-runtime-readiness';
import { useOnboardingAnalytics } from '../onboarding-analytics';
import { onboardingSurface as surface } from './surface';

// Marks the chosen row, not focus: it stays whatever the input modality.
const ROW_RING = `0 0 0 2px ${colors.accent}, ${shadow.card}`;

const styles = stylex.create({
  scroller: {
    maxHeight: 'calc(4 * 4.25rem + 0.75rem * 3)',
    overflowY: 'auto',
    overscrollBehavior: 'contain',
    marginInline: '-4px',
    marginBlock: '-4px',
    paddingInline: '4px',
    paddingBlock: '4px',
  },
  rows: { display: 'flex', flexDirection: 'column', gap: space[3] },
  /**
   * An agent is a choice on the card rung. The slots below are rem, not the
   * package's px steps, because `ProviderSetupRow` states the same columns in
   * rem and the two kinds of row share one grid.
   */
  row: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    minWidth: 0,
    backgroundColor: colors.elevatedBackground,
    boxShadow: shadow.card,
    borderRadius: radius.large,
    cornerShape: corner.shape,
    transitionProperty: 'background-color, box-shadow',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  rowHover: {
    backgroundColor: {
      default: colors.elevatedBackground,
      ':hover': `color-mix(in oklab, ${colors.elevatedBackground}, ${colors.label} 4%)`,
    },
  },
  /** Only selection marks a row; the ring takes the round corner. */
  rowSelected: { boxShadow: ROW_RING, cornerShape: corner.round },
  select: {
    boxSizing: 'border-box',
    display: 'flex',
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    alignItems: 'center',
    gap: space[3],
    minWidth: 0,
    margin: 0,
    paddingBlock: space[3],
    paddingInline: space[3],
    borderWidth: 0,
    borderStyle: 'none',
    outlineStyle: 'none',
    backgroundColor: 'transparent',
    boxShadow: {
      default: 'none',
      ':focus-visible': `inset 0 0 0 ${focus.ringWidth} ${colors.accent}`,
    },
    borderStartStartRadius: radius.large,
    borderEndStartRadius: radius.large,
    cornerShape: corner.round,
    color: colors.label,
    fontFamily: 'inherit',
    textAlign: 'start',
    cursor: 'pointer',
  },
  selectDisabled: { opacity: 0.45, cursor: 'not-allowed' },
  statusSlot: { display: 'flex', flexShrink: 0, justifyContent: 'flex-end', minWidth: '5rem' },
  cluster: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: space[1],
    paddingBlock: space[3],
    paddingInlineEnd: space[3],
  },
  editSlot: { display: 'flex', flexShrink: 0, justifyContent: 'center', width: '3rem' },
  actionSlot: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: space[1],
    width: '5rem',
  },
  /** Layout only: the progress pill fills its slot, as it does in a setup row. */
  fillSlot: { width: '100%' },
  authPanel: {
    flexBasis: '100%',
    paddingBottom: space[3],
    paddingInlineStart: '3.25rem',
    paddingInlineEnd: space[3],
  },
  showcase: { display: 'flex', flexDirection: 'column', gap: space[3], paddingTop: space[2] },
  wall: { display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: space[1] },
  /** A brand at rest is a monochrome mark on the region fill. */
  chipMark: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    width: '24px',
    height: '24px',
    borderRadius: radius.full,
    cornerShape: corner.round,
    backgroundColor: `color-mix(in oklab, transparent, ${colors.label} 4%)`,
    color: colors.secondaryLabel,
  },
  /** A tooltip is one ink; its title and its sentence differ by weight alone. */
  tipTitle: { fontWeight: 600 },
  tipDetail: { marginTop: space[1], overflowWrap: 'anywhere' },
});

export type ProviderTestStatus = OnboardingProviderStatus | 'needs-auth';

const PROVIDERS_SCREEN_MACHINE_TIMEOUT_MS = 15_000;

/**
 * One brand on the onboarding "logo wall". `pick` is handed back to `onAdd` so
 * the container opens the create dialog pre-selected to the right provider;
 * `icon` carries just enough for {@link AgentIcon} to render the glyph (registry
 * agents resolve from REGISTRY_AGENT_ICON_SVGS, presets from their brand icon).
 */
type ShowcasePick =
  | { kind: 'builtin'; agentType: BuiltinAgentType }
  | { kind: 'registry'; id: string }
  | { kind: 'preset'; presetId: string };

type ShowcaseAgent = {
  pick: ShowcasePick;
  /** Short display name (registry `name` can be verbose, e.g. "Codebuddy Code"). */
  label: string;
  icon:
    | { cliType: 'registry'; agentType: string }
    | { cliType: 'builtin'; agentType: string; brandId?: AgentBrandId };
};

function showcasePickKey(pick: ShowcasePick): string {
  return pick.kind === 'builtin'
    ? `builtin:${pick.agentType}`
    : pick.kind === 'registry'
      ? `registry:${pick.id}`
      : `preset:${pick.presetId}`;
}

function builtinShowcase(agentType: BuiltinAgentType, label: string): ShowcaseAgent {
  return { pick: { kind: 'builtin', agentType }, label, icon: { cliType: 'builtin', agentType } };
}

function registryShowcase(id: string, label: string): ShowcaseAgent {
  return { pick: { kind: 'registry', id }, label, icon: { cliType: 'registry', agentType: id } };
}

function presetShowcase(presetId: string, label: string, brandId: AgentBrandId): ShowcaseAgent {
  return {
    pick: { kind: 'preset', presetId },
    label,
    icon: { cliType: 'builtin', agentType: 'claude', brandId },
  };
}

/**
 * Always-visible brands beneath the Add button — makes it obvious Lody runs far
 * more than the two built-ins. Curated to ~two rows; DeepSeek Harness shows
 * here, the other presets live under "其他". Each maps to a
 * {@link REGISTRY_ACP_AGENTS} entry or a preset, so the icon and the quick-add
 * prefill share one source of truth.
 */
const FEATURED_SHOWCASE_AGENTS: ShowcaseAgent[] = [
  builtinShowcase('kimi', 'Kimi'),
  builtinShowcase('grok', 'Grok'),
  registryShowcase('amp-acp', 'Amp'),
  registryShowcase('cursor', 'Cursor'),
  registryShowcase('opencode', 'OpenCode'),
  registryShowcase('devin', 'Devin'),
  registryShowcase('dimcode', 'DimCode'),
  registryShowcase('pi-acp', 'Pi'),
  registryShowcase('factory-droid', 'Factory Droid'),
  registryShowcase('github-copilot-cli', 'GitHub Copilot'),
  builtinShowcase('deepseek', 'DeepSeek'),
];

const FEATURED_SHOWCASE_REGISTRY_IDS = new Set(
  FEATURED_SHOWCASE_AGENTS.flatMap((a) => (a.pick.kind === 'registry' ? [a.pick.id] : []))
);

/**
 * The rest, revealed by the "其他" chip: the MiMo / MiniMax presets followed by
 * every other registry agent that ships a brand icon. The registry tail is
 * derived so it stays correct as the generated list grows. `claude-p` (built-in
 * Claude) and `kimi-code` (a Kimi alias) are dropped as redundant.
 */
const MORE_SHOWCASE_AGENTS: ShowcaseAgent[] = [
  presetShowcase(MIMO_CLAUDE_PRESET_ID, 'MiMo', 'mimo'),
  presetShowcase(MINIMAX_CLAUDE_PRESET_ID, 'MiniMax', 'minimax'),
  presetShowcase(GLM_CLAUDE_PRESET_ID, 'GLM', 'glm'),
  ...REGISTRY_ACP_AGENTS.filter(
    (a) =>
      a.id !== 'claude-p' &&
      a.id !== 'kimi' &&
      a.id !== 'kimi-code' &&
      !FEATURED_SHOWCASE_REGISTRY_IDS.has(a.id) &&
      Boolean(REGISTRY_AGENT_ICON_SVGS[a.id])
  ).map((a) => registryShowcase(a.id, a.name)),
];

export interface ProvidersScreenViewProps {
  /** Local-machine providers to render in the list. */
  configs: AgentConfigMeta[];
  /** Durable providers still being prepared on the target machine. */
  setups?: ProviderSetupTask[];
  /** Per-config test status, keyed by config id. */
  testStatuses: Record<string, ProviderTestStatus>;
  /** Ephemeral request-scoped work; deliberately separate from the last result. */
  testActivities?: Record<string, ProviderTestActivity>;
  /** Latest failed probe detail, kept available after its toast disappears. */
  failureReasons?: Record<string, string>;
  /**
   * Readiness of the managed built-in runtimes the background prefetch warms.
   * Passed in rather than read from a runtime atom so this half stays
   * presentational and story-renderable.
   */
  runtimeReadiness?: Partial<Record<ManagedBuiltinAgentType, AgentRuntimeReadiness>>;
  selectedProviderId?: string | null;
  /** True when the local machine record has not yet arrived. */
  noLocalMachine: boolean;
  localMachineId?: MachineId | null;
  localMachine?: MachineViewMeta;
  /** Open the edit dialog for an existing provider. */
  onEdit: (config: AgentConfigMeta) => void;
  onSelect?: (config: AgentConfigMeta) => void;
  /** Run the connectivity test (or re-test) for a row. */
  onTest: (config: AgentConfigMeta) => void;
  onAuthenticated?: (config: AgentConfigMeta) => void | Promise<void>;
  /** Delete a row (the confirm step is also handled here). */
  onDelete: (config: AgentConfigMeta) => void;
  onRetrySetup?: (setup: ProviderSetupTask) => Promise<void>;
  onDeleteSetup?: (setup: ProviderSetupTask) => Promise<void>;
  /**
   * Open the create dialog. Pass a showcase `pick` to pre-select that provider;
   * omit it for a blank create flow.
   */
  onAdd: (pick?: ShowcasePick) => void;
  onBack: () => void;
  /** Defer provider setup and jump to the next step. */
  onSkip: () => void;
  onNext: (selection: DesktopOnboardingProviderSelection) => void;
}

export function ProvidersScreenView({
  configs,
  setups = [],
  testStatuses,
  testActivities = {},
  failureReasons = {},
  runtimeReadiness = {},
  selectedProviderId,
  noLocalMachine,
  localMachineId = null,
  localMachine,
  onEdit,
  onSelect,
  onTest,
  onAuthenticated,
  onDelete,
  onRetrySetup,
  onDeleteSetup,
  onAdd,
  onBack,
  onSkip,
  onNext,
}: ProvidersScreenViewProps) {
  const { t } = useTranslation();
  const canProceed = !noLocalMachine && configs.length + setups.length > 0;
  const resolvedSelectedProviderId = selectedProviderId ?? configs[0]?.id ?? setups[0]?.id ?? null;
  const previewConfig = configs.find((config) => config.id === resolvedSelectedProviderId);
  const previewSetup = setups.find((setup) => setup.id === resolvedSelectedProviderId);
  const selectedProvider: DesktopOnboardingProviderSelection | null = previewConfig
    ? { kind: 'agentConfig', agentConfigId: previewConfig.id, agentName: previewConfig.name }
    : previewSetup
      ? {
          kind: 'providerSetup',
          providerSetupId: previewSetup.id,
          agentName: previewSetup.config.name,
        }
      : null;
  const previewStatus = previewConfig ? testStatuses[previewConfig.id] : undefined;
  const previewActivity = previewConfig ? testActivities[previewConfig.id] : undefined;
  const previewAgentStatus: TourConfigurationState['agentStatus'] = noLocalMachine
    ? 'missing'
    : previewActivity
      ? 'verifying'
      : previewStatus === 'needs-auth'
        ? 'awaiting-auth'
        : previewStatus === 'failed'
          ? 'failed'
          : previewConfig
            ? 'ready'
            : setups.length > 0
              ? 'preparing'
              : 'missing';

  return (
    <OnboardingShell
      stepKey="providers"
      size="wide"
      title={t('onboarding.providers.title', 'Connect a coding agent')}
      description={t(
        'onboarding.providers.description',
        'Add an Agent now. Lody will continue setup and let you know if anything needs your attention.'
      )}
      previewIdentity={
        previewConfig
          ? {
              agentName: previewConfig.name,
              agentType: previewConfig.agentType,
              agentCliType: previewConfig.cliType,
            }
          : undefined
      }
      previewState={{
        agentStatus: previewAgentStatus,
        runConfigAgents: configs.map((config) => ({
          cliType: config.cliType,
          agentType: config.agentType,
          brandId: config.brandId,
          env: config.env,
        })),
      }}
      secondaryAction={<OnboardingBackButton onClick={onBack} />}
      primaryAction={
        <div {...stylex.props(surface.actions)}>
          <Button variant="ghost" size="large" onClick={onSkip}>
            {t('onboarding.providers.skip', 'Skip for now')}
          </Button>
          <OnboardingNextButton
            onClick={() => selectedProvider && onNext(selectedProvider)}
            disabled={!canProceed || selectedProvider === null}
          />
        </div>
      }
    >
      <div {...stylex.props(surface.stack)}>
        {noLocalMachine ? (
          <div {...stylex.props(surface.message, surface.messageInline, surface.messageNeutral)}>
            <Spinner size="small" />
            {t('onboarding.providers.waitingMachine', 'Waiting for the local agent to connect…')}
          </div>
        ) : null}

        {configs.length > 0 || setups.length > 0 ? (
          // Cap at ~4 rows; longer lists scroll. The scroller's negative margin
          // and matching padding keep shadows and rings from clipping at its edge.
          <div {...withClassName(stylex.props(styles.scroller), 'scrollbar-pro')}>
            <div {...stylex.props(styles.rows)}>
              {setups.map((setup) => (
                <ProviderSetupRow
                  key={setup.id}
                  setup={setup}
                  machine={localMachine}
                  onRetry={onRetrySetup ?? (async () => undefined)}
                  onDelete={onDeleteSetup ?? (async () => undefined)}
                />
              ))}
              <AnimatePresence initial={false}>
                {configs.map((config) => {
                  const status: ProviderTestStatus = testStatuses[config.id] ?? 'untested';
                  const activity = testActivities[config.id];
                  const selected = config.id === resolvedSelectedProviderId;
                  // 'needs-auth' stays ready on purpose: that agent arrived, it
                  // is waiting on the user, and the row's panel says so.
                  const rowReadiness: AgentRuntimeReadiness =
                    agentRuntimeReadinessFromActivity(activity) ??
                    (status === 'failed'
                      ? { readiness: 'cold', percent: null }
                      : { readiness: 'ready', percent: null });
                  return (
                    <motion.div
                      key={config.id}
                      layout
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -8 }}
                      transition={{ duration: 0.25 }}
                      // Hover lives on the row, not the inner select button, so
                      // highlighting reads as one unit even though Edit, Test and
                      // Delete are separate click targets. Only selection marks
                      // the row: a passed row used to carry the same wash, which
                      // made the selection indistinguishable from status. Status
                      // lives in the badge column alone.
                      {...stylex.props(styles.row, selected ? styles.rowSelected : styles.rowHover)}
                    >
                      <button
                        type="button"
                        disabled={noLocalMachine}
                        aria-pressed={selected}
                        aria-label={t('onboarding.providers.selectConfig', 'Select {{name}}', {
                          name: config.name,
                        })}
                        onClick={() => (onSelect ? onSelect(config) : onEdit(config))}
                        {...stylex.props(styles.select, noLocalMachine && styles.selectDisabled)}
                      >
                        {/* The mark carries the work, so the row needs no second
                            activity element. A published config reads as ready
                            unless a request is running on it or it failed:
                            dimming an agent the user already has, because we
                            have not probed it, is the anxiety this replaces. */}
                        <AgentReadinessMark
                          cliType={config.cliType}
                          agentType={config.agentType}
                          brandId={config.brandId}
                          env={config.env}
                          readiness={rowReadiness.readiness}
                          percent={rowReadiness.percent}
                          size="md"
                        />
                        <span {...stylex.props(surface.textColumn)}>
                          <span {...stylex.props(surface.title)}>{config.name}</span>
                          <span {...stylex.props(surface.detail)}>
                            {labelForAgent(config.cliType, config.agentType)}
                          </span>
                        </span>
                        {/* Sibling of the two-line text column, so the badge
                            centres against the whole row instead of riding the
                            name's baseline. The column is fixed and its
                            contents end-aligned: every badge then shares one
                            edge and one gutter to the actions, whatever word it
                            happens to carry. */}
                        <span {...stylex.props(styles.statusSlot)}>
                          <ProviderStatusBadge
                            status={status}
                            activity={activity}
                            failureReason={failureReasons[config.id]}
                          />
                        </span>
                      </button>
                      {/* Fixed-width slots, not intrinsic ones. Test/Re-test,
                          the progress pill and the needs-auth row all differ in
                          width, and an intrinsic cluster passed that difference
                          leftward: the badge and the name column landed at a
                          different x in every row, and jumped again the moment a
                          test started. A control keeps its own size inside its
                          slot; the slot is what never moves. */}
                      <div {...stylex.props(styles.cluster)}>
                        <div {...stylex.props(styles.editSlot)}>
                          <Button variant="ghost" size="small" onClick={() => onEdit(config)}>
                            {t('common.edit', 'Edit')}
                          </Button>
                        </div>
                        <div {...stylex.props(styles.actionSlot)}>
                          {activity ? (
                            <ProviderActivityAction activity={activity} config={config} />
                          ) : status !== 'needs-auth' ? (
                            // Keep the same visual role after success. Changing
                            // the action to a ghost made the verified row read
                            // as a hole in this fixed-width column.
                            <Button
                              variant="secondary"
                              size="small"
                              disabled={noLocalMachine}
                              onClick={() => onTest(config)}
                            >
                              {status === 'passed'
                                ? t('onboarding.providers.retest', 'Re-test')
                                : t('onboarding.providers.test', 'Test')}
                            </Button>
                          ) : null}
                        </div>
                        <Button
                          variant="ghost"
                          size="small"
                          aria-label={t('common.delete', 'Delete')}
                          icon
                          tone="destructive"
                          onClick={() => onDelete(config)}
                        >
                          <Trash2 {...stylex.props(surface.icon16)} />
                        </Button>
                      </div>
                      {/* Indented to the agent's name, not the card edge: the
                          panel belongs to the agent named above it. */}
                      {status === 'needs-auth' ? (
                        <div {...stylex.props(styles.authPanel)}>
                          <AcpAuthenticationPanel
                            machineId={localMachineId}
                            configId={config.id}
                            cliType={config.cliType}
                            agentType={config.agentType}
                            customAcp={config.customAcp}
                            runtimeOverrides={config.runtimeOverrides}
                            env={config.env}
                            compact
                            onAuthenticated={() => onAuthenticated?.(config)}
                          />
                        </div>
                      ) : null}
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            </div>
          </div>
        ) : null}

        <Button
          type="button"
          variant="secondary"
          size="large"
          disabled={noLocalMachine}
          onClick={() => onAdd()}
        >
          <Plus {...stylex.props(surface.icon16)} />
          {configs.length + setups.length === 0
            ? t('onboarding.providers.addFirst', 'Add your first Agent')
            : t('onboarding.providers.addAnother', 'Add another Agent')}
        </Button>

        {!noLocalMachine && !canProceed ? (
          <p {...stylex.props(surface.hint, surface.hintCentered)}>
            {t(
              'onboarding.providers.needTested',
              'Add an Agent to continue, or skip and configure later.'
            )}
          </p>
        ) : null}

        <AgentShowcase
          disabled={noLocalMachine}
          onPick={onAdd}
          runtimeReadiness={runtimeReadiness}
        />
      </div>
    </OnboardingShell>
  );
}

/**
 * The glyph inside a showcase chip.
 *
 * Only the managed built-in runtimes the background prefetch warms get the
 * readiness treatment, and they light up from monochrome to full brand colour
 * as each one lands. The rest keep the wall's resting monochrome look, because
 * nothing is being prepared for them and a dimmed mark would imply otherwise.
 */
function ShowcaseChipMark({
  agent,
  runtimeReadiness,
}: {
  agent: ShowcaseAgent;
  runtimeReadiness: Partial<Record<ManagedBuiltinAgentType, AgentRuntimeReadiness>>;
}) {
  const warmed =
    agent.pick.kind === 'builtin' && isManagedBuiltinAgentType(agent.pick.agentType)
      ? runtimeReadiness[agent.pick.agentType]
      : undefined;

  if (warmed) {
    return (
      <AgentReadinessMark
        cliType={agent.icon.cliType}
        agentType={agent.icon.agentType}
        brandId={agent.icon.cliType === 'builtin' ? agent.icon.brandId : undefined}
        readiness={warmed.readiness}
        percent={warmed.percent}
        size="sm"
        className="rounded-full bg-muted/50"
      />
    );
  }

  return (
    <span {...stylex.props(styles.chipMark)}>
      <AgentIcon
        cliType={agent.icon.cliType}
        agentType={agent.icon.agentType}
        brandId={agent.icon.cliType === 'builtin' ? agent.icon.brandId : undefined}
        className={stylex.props(surface.icon14).className}
      />
    </span>
  );
}

/**
 * "Logo wall" of supported ACP agents. Communicates that Lody runs far more
 * than the two built-ins; clicking a brand opens the create dialog pre-selected
 * to that agent. Icons inherit `currentColor` for a cohesive monochrome look
 * that brightens to full brand contrast on hover.
 */
function AgentShowcase({
  disabled,
  onPick,
  runtimeReadiness,
}: {
  disabled: boolean;
  onPick: (pick: ShowcasePick) => void;
  runtimeReadiness: Partial<Record<ManagedBuiltinAgentType, AgentRuntimeReadiness>>;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const moreCount = MORE_SHOWCASE_AGENTS.length;
  const visible = expanded
    ? [...FEATURED_SHOWCASE_AGENTS, ...MORE_SHOWCASE_AGENTS]
    : FEATURED_SHOWCASE_AGENTS;

  return (
    <div {...stylex.props(styles.showcase)}>
      <p aria-hidden {...stylex.props(surface.hint, surface.hintCentered)}>
        {t('onboarding.providers.moreLabel', 'Plus many more coding agents')}
      </p>
      <div {...stylex.props(styles.wall)}>
        {visible.map((agent) => (
          <Button
            key={showcasePickKey(agent.pick)}
            type="button"
            variant="ghost"
            shape="pill"
            disabled={disabled}
            title={agent.label}
            onClick={() => onPick(agent.pick)}
          >
            <ShowcaseChipMark agent={agent} runtimeReadiness={runtimeReadiness} />
            {agent.label}
          </Button>
        ))}

        {moreCount > 0 ? (
          <Button
            type="button"
            variant="ghost"
            shape="pill"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? (
              <>
                {t('onboarding.providers.showLess', 'Show less')}
                <ChevronUp {...stylex.props(surface.icon14)} />
              </>
            ) : (
              <>
                {t('onboarding.providers.showMore', '+{{count}} more', { count: moreCount })}
                <ChevronDown {...stylex.props(surface.icon14)} />
              </>
            )}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

interface ProvidersScreenProps {
  onBack: () => void;
  onSkip: () => void;
  onNext: (selection: DesktopOnboardingProviderSelection) => void;
  onManagedRuntimeSelected: (agentType: ManagedBuiltinAgentType) => void;
}

export function ProvidersScreen({
  onBack,
  onSkip,
  onNext,
  onManagedRuntimeSelected,
}: ProvidersScreenProps) {
  const { t } = useTranslation();
  const analytics = useOnboardingAnalytics();
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const localMachineId = useAtomValue(localMachineIdAtom);
  const localProbeAttempted = useAtomValue(localProbeAttemptedAtom);
  const { machines } = useVisibleMachineMetas();
  const localMachineIdsForAgentConfigs = useMemo(
    () => (localMachineId === null ? [] : [localMachineId]),
    [localMachineId]
  );
  useMachineFlockAgentConfigsForMachineIds(localMachineIdsForAgentConfigs);
  const allConfigs = useAtomValue(getAllAgentConfigAtom);
  const allSetups = useAtomValue(getAllProviderSetupsAtom);
  const createConfig = useSetAtom(cmdCreateAgentConfigAtom);
  const createSetup = useSetAtom(cmdCreateProviderSetupAtom);
  const retrySetup = useSetAtom(cmdRetryProviderSetupAtom);
  const updateConfig = useSetAtom(cmdUpdateAgentConfigAtom);
  const deleteConfig = useSetAtom(deleteAgentConfigAtom);
  const deleteSetup = useSetAtom(deleteProviderSetupAtom);

  const localMachine: MachineViewMeta | undefined = useMemo(() => {
    if (localMachineId === null) return undefined;
    return machines.get(localMachineId);
  }, [localMachineId, machines]);

  const localConfigs = useMemo(
    () =>
      allConfigs
        .filter((c) => localMachineId !== null && c.machineId === localMachineId)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [allConfigs, localMachineId]
  );
  const localSetups = useMemo(
    () =>
      allSetups
        .filter((setup) => localMachineId !== null && setup.machineId === localMachineId)
        .sort((left, right) => left.createdAt - right.createdAt),
    [allSetups, localMachineId]
  );
  useProviderSetupRuntimeProgress(runtime, workspaceId, localSetups);
  const runtimeReadiness = useBuiltinRuntimeReadiness(localMachineId);

  const [dialogMode, setDialogMode] = useState<AgentConfigDialogMode | null>(null);
  const dialogOpen = dialogMode !== null;

  const [testStatuses, setTestStatuses] = useState<Record<string, ProviderTestStatus>>({});
  const [testActivities, setTestActivities] = useState<Record<string, ProviderTestActivity>>({});
  const [failureReasons, setFailureReasons] = useState<Record<string, string>>({});
  const testRunsRef = useRef(createProviderTestRunRegistry());
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AgentConfigMeta | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    const availableIds = new Set([
      ...localConfigs.map((config) => config.id),
      ...localSetups.map((setup) => setup.id),
    ]);
    if (selectedProviderId && availableIds.has(selectedProviderId as AgentConfigId)) return;
    setSelectedProviderId(localConfigs[0]?.id ?? localSetups[0]?.id ?? null);
  }, [localConfigs, localSetups, selectedProviderId]);

  const setStatus = (id: AgentConfigId, status: ProviderTestStatus) =>
    setTestStatuses((prev) => ({ ...prev, [id]: status }));

  const clearFailureReason = useCallback((id: AgentConfigId) => {
    setFailureReasons((prev) => {
      if (!(id in prev)) return prev;
      const { [id]: _, ...rest } = prev;
      return rest;
    });
  }, []);

  const clearTestActivity = useCallback((id: AgentConfigId) => {
    setTestActivities((prev) => {
      if (!(id in prev)) return prev;
      const { [id]: _, ...rest } = prev;
      return rest;
    });
  }, []);

  const invalidateTestRun = useCallback(
    (id: AgentConfigId) => {
      testRunsRef.current.invalidate(id);
      clearTestActivity(id);
    },
    [clearTestActivity]
  );

  // Detach, never abort: leaving this step stops the screen from committing a
  // result it can no longer show, but the machine keeps working. The refresh
  // writes durable capabilities, so a recovery that outlives the step still
  // finishes the job the user asked for.
  useEffect(
    () => () => {
      testRunsRef.current.detachAll();
    },
    []
  );

  // Seed configs only from a past authoritative Test/Refresh. Static built-in
  // capabilities describe expected UI options, not a successful runtime probe,
  // so they must never produce a Verified badge. Don't downgrade an explicit
  // 'failed' / 'passed'. A current activity is stored separately and must not
  // erase the last known result while a re-test is in flight.
  // Depend on the cache map directly: `localMachine` identity rebuilds whenever
  // the visible-machine index recomputes, which would re-fire this effect for
  // unrelated reasons.
  const acpCapabilities = localMachine?.acpCapabilities;
  useEffect(() => {
    setTestStatuses((prev) => {
      let next = prev;
      for (const config of localConfigs) {
        const existing = prev[config.id];
        if (existing === 'failed' || existing === 'passed') continue;
        if (resolveInitialOnboardingProviderStatus(config, acpCapabilities) === 'passed') {
          if (next === prev) next = { ...prev };
          next[config.id] = 'passed';
        }
      }
      return next;
    });
  }, [localConfigs, acpCapabilities]);

  // If the local machine never arrives, silently restart the CLI once and
  // give it another window to reconnect. If it still doesn't show up, surface
  // a single toast and let the user retry/refresh manually — we don't want a
  // verbose recovery panel in the onboarding flow.
  useEffect(() => {
    let cancelled = false;
    let firstTimeoutId: number | null = null;
    let secondTimeoutId: number | null = null;

    if (!localMachine && localProbeAttempted) {
      firstTimeoutId = window.setTimeout(() => {
        if (cancelled) return;
        const services = getIpcServices();
        const restart = services ? services.cli.restart.bind(services.cli) : undefined;
        if (!restart) {
          console.error(
            '[onboarding] Local agent restart is unavailable while waiting for provider setup'
          );
          analytics.capture('onboarding/operation_failed', {
            step: 'providers',
            operation: 'local_agent_recovery',
            failure_code: 'restart_unavailable',
            retryable: true,
          });
          toast.error(
            t(
              'onboarding.providers.localAgentUnreachable',
              'Could not reach the local agent. Please restart Lody and try again.'
            )
          );
          return;
        }

        const restartStartedAtMs = analytics.now();
        analytics.capture('onboarding/operation_started', {
          step: 'providers',
          operation: 'local_agent_restart',
        });
        void restart()
          .then((result) => {
            if (cancelled) return;
            if (!result.ok) {
              throw new Error(result.error || 'restart_failed');
            }
            analytics.capture('onboarding/operation_succeeded', {
              step: 'providers',
              operation: 'local_agent_restart',
              duration_ms: analytics.durationSince(restartStartedAtMs),
            });
            secondTimeoutId = window.setTimeout(() => {
              if (cancelled) return;
              console.error(
                '[onboarding] Local agent remained unreachable after an automatic restart'
              );
              analytics.capture('onboarding/operation_failed', {
                step: 'providers',
                operation: 'local_agent_recovery',
                failure_code: 'local_agent_unreachable',
                retryable: true,
              });
              toast.error(
                t(
                  'onboarding.providers.localAgentUnreachable',
                  'Could not reach the local agent. Please restart Lody and try again.'
                )
              );
            }, PROVIDERS_SCREEN_MACHINE_TIMEOUT_MS);
          })
          .catch((error) => {
            if (cancelled) return;
            console.error('[onboarding] Failed to restart the local agent:', error);
            analytics.capture('onboarding/operation_failed', {
              step: 'providers',
              operation: 'local_agent_restart',
              failure_code: 'local_agent_restart_failed',
              duration_ms: analytics.durationSince(restartStartedAtMs),
              retryable: true,
            });
            toast.error(
              t(
                'onboarding.providers.localAgentUnreachable',
                'Could not reach the local agent. Please restart Lody and try again.'
              ),
              { description: error instanceof Error ? error.message : String(error) }
            );
          });
      }, PROVIDERS_SCREEN_MACHINE_TIMEOUT_MS);
    }

    return () => {
      cancelled = true;
      if (firstTimeoutId !== null) window.clearTimeout(firstTimeoutId);
      if (secondTimeoutId !== null) window.clearTimeout(secondTimeoutId);
    };
  }, [analytics, localMachine, localProbeAttempted, t]);

  const refreshCapabilities = useCallback(
    async (args: {
      machineId: MachineId;
      configId: AgentConfigId;
      signal?: AbortSignal;
      onProgress?: (progress: MachineAcpBinaryProgressMessage) => void;
    }) => {
      if (!runtime || workspaceId === null || localMachineId === null) {
        throw new Error(t('chat.validation.missingContext', 'Missing workspace context'));
      }
      const response = await runtime.requestMachineAcpCapabilitiesRefresh(
        {
          type: 'machine/acp-capabilities-refresh',
          machineId: args.machineId,
          workspaceId,
          configId: args.configId,
        },
        { signal: args.signal, onProgress: args.onProgress }
      );
      if (!response) {
        throw new Error(
          t('agents.acpCapabilities.refreshTimeout', 'Refresh timed out, please try again')
        );
      }
      if (!response.success) {
        if (response.authRequired) {
          return response;
        }
        throw new Error(
          response.error || t('agents.acpCapabilities.refreshError', 'Refresh failed')
        );
      }
      // The machine flock doc only syncs once per session; force a re-sync so
      // the freshly probed capabilities surface without a reload.
      await resyncMachineFlockRows(runtime, args.machineId, {
        refreshedCapability: response.capability
          ? { configId: response.configId, value: response.capability }
          : undefined,
      });
      return response;
    },
    [localMachineId, runtime, t, workspaceId]
  );

  const { checkBinaryStatus, installBinary } = useMachineAcpBinaryActions(runtime, workspaceId);

  // New built-in configs are live-probed by AgentConfigDialog when Create is
  // pressed. This explicit Test action remains for already-created provider rows.
  const handleTest = useCallback(
    (config: AgentConfigMeta) => {
      const run = testRunsRef.current.start(config.id);
      const startedAtMs = analytics.now();
      analytics.capture('onboarding/operation_started', {
        step: 'providers',
        operation: 'agent_test',
      });
      setTestActivities((prev) => ({
        ...prev,
        [config.id]: { phase: 'checking-runtime', startedAtMs: Date.now() },
      }));
      void (async () => {
        try {
          const response = await refreshCapabilities({
            machineId: config.machineId,
            configId: config.id,
            signal: run.signal,
            onProgress: (progress) => {
              if (!testRunsRef.current.isCurrent(config.id, run)) return;
              setTestActivities((prev) => ({
                ...prev,
                [config.id]: {
                  ...providerTestActivityFromProgress(progress),
                  // Elapsed time belongs to the request, not to the stage it
                  // happens to be in, so it survives every phase change.
                  ...(prev[config.id]?.startedAtMs !== undefined
                    ? { startedAtMs: prev[config.id]?.startedAtMs }
                    : {}),
                },
              }));
            },
          });
          if (!testRunsRef.current.finish(config.id, run)) return;
          clearTestActivity(config.id);
          clearFailureReason(config.id);
          setStatus(config.id, response.authRequired ? 'needs-auth' : 'passed');
          analytics.capture('onboarding/operation_succeeded', {
            step: 'providers',
            operation: 'agent_test',
            result: response.authRequired ? 'needs_auth' : 'passed',
            duration_ms: analytics.durationSince(startedAtMs),
          });
        } catch (error) {
          if (!testRunsRef.current.finish(config.id, run)) return;
          console.error(`[onboarding] Failed to test Agent ${config.name}:`, error);
          analytics.capture('onboarding/operation_failed', {
            step: 'providers',
            operation: 'agent_test',
            failure_code: 'agent_test_failed',
            duration_ms: analytics.durationSince(startedAtMs),
            retryable: true,
          });
          clearTestActivity(config.id);
          const failureReason = error instanceof Error ? error.message : String(error);
          setFailureReasons((prev) => ({ ...prev, [config.id]: failureReason }));
          setStatus(config.id, 'failed');
          toast.error(
            t('settings.agent.provider.refreshFailed', 'Failed to refresh {{agent}}', {
              agent: config.name,
            }),
            { description: failureReason }
          );
        }
      })();
    },
    [analytics, clearFailureReason, clearTestActivity, refreshCapabilities, t]
  );

  const handleDialogSubmit = useCallback(
    async (payload: AgentConfigSubmitPayload) => {
      if (!localMachineId || !dialogMode) return;
      const operation =
        dialogMode.kind === 'edit'
          ? 'agent_config_update'
          : payload.backgroundSetup
            ? 'agent_setup_create'
            : 'agent_config_create';
      const startedAtMs = analytics.now();
      analytics.capture('onboarding/operation_started', { step: 'providers', operation });
      try {
        if (dialogMode.kind === 'create') {
          const config: AgentConfigMeta = {
            id: payload.id,
            name: payload.name,
            description: payload.description,
            cliType: payload.cliType,
            agentType: payload.agentType,
            customAcp: payload.customAcp,
            runtimeOverrides: payload.runtimeOverrides,
            env: payload.env,
            prompt: payload.prompt,
            titleGeneration: payload.titleGeneration,
            brandId: payload.brandId,
            machineId: localMachineId,
          };
          if (payload.backgroundSetup) {
            await createSetup(config);
          } else {
            await createConfig(config);
          }
          setSelectedProviderId(config.id);
        } else {
          invalidateTestRun(dialogMode.config.id);
          await updateConfig({
            id: dialogMode.config.id,
            machineId: dialogMode.config.machineId,
            name: payload.name,
            description: payload.description,
            cliType: payload.cliType,
            agentType: payload.agentType,
            customAcp: payload.customAcp,
            runtimeOverrides: payload.runtimeOverrides,
            env: payload.env,
            prompt: payload.prompt,
            titleGeneration: payload.titleGeneration,
            brandId: payload.brandId,
          });
          // Editing can change credentials or the launch command; keep Test as
          // an explicit optional action instead of treating save as verification.
          clearFailureReason(dialogMode.config.id);
          setStatus(dialogMode.config.id, 'untested');
        }
        analytics.capture('onboarding/operation_succeeded', {
          step: 'providers',
          operation,
          duration_ms: analytics.durationSince(startedAtMs),
        });
      } catch (error) {
        console.error('[onboarding] Failed to save Agent configuration:', error);
        analytics.capture('onboarding/operation_failed', {
          step: 'providers',
          operation,
          failure_code: `${operation}_failed`,
          duration_ms: analytics.durationSince(startedAtMs),
          retryable: true,
        });
        toast.error(
          dialogMode.kind === 'create'
            ? t('agents.createConfigError', 'Failed to create configuration')
            : t('agents.updateConfigError', 'Failed to update configuration')
        );
        throw error;
      }
    },
    [
      analytics,
      clearFailureReason,
      createConfig,
      createSetup,
      dialogMode,
      invalidateTestRun,
      localMachineId,
      t,
      updateConfig,
    ]
  );

  const handleRetrySetup = useCallback(
    async (setup: ProviderSetupTask) => {
      const startedAtMs = analytics.now();
      analytics.capture('onboarding/operation_started', {
        step: 'providers',
        operation: 'agent_setup_retry_request',
        attempt: setup.attempt + 1,
      });
      try {
        await retrySetup(setup.id);
        analytics.capture('onboarding/operation_succeeded', {
          step: 'providers',
          operation: 'agent_setup_retry_request',
          attempt: setup.attempt + 1,
          duration_ms: analytics.durationSince(startedAtMs),
        });
      } catch (error) {
        console.error('[onboarding] Failed to retry Agent setup:', error);
        analytics.capture('onboarding/operation_failed', {
          step: 'providers',
          operation: 'agent_setup_retry_request',
          failure_code: 'agent_setup_retry_failed',
          attempt: setup.attempt + 1,
          duration_ms: analytics.durationSince(startedAtMs),
          retryable: true,
        });
        toast.error(t('settings.agent.setup.retryFailed', 'Could not retry provider setup'), {
          description: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    [analytics, retrySetup, t]
  );

  const handleDeleteSetup = useCallback(
    async (setup: ProviderSetupTask) => {
      const startedAtMs = analytics.now();
      analytics.capture('onboarding/operation_started', {
        step: 'providers',
        operation: 'agent_setup_cancel',
      });
      try {
        await deleteSetup(setup.id);
        analytics.capture('onboarding/operation_succeeded', {
          step: 'providers',
          operation: 'agent_setup_cancel',
          duration_ms: analytics.durationSince(startedAtMs),
        });
      } catch (error) {
        console.error('[onboarding] Failed to cancel Agent setup:', error);
        analytics.capture('onboarding/operation_failed', {
          step: 'providers',
          operation: 'agent_setup_cancel',
          failure_code: 'agent_setup_cancel_failed',
          duration_ms: analytics.durationSince(startedAtMs),
          retryable: true,
        });
        toast.error(t('settings.agent.setup.deleteFailed', 'Could not cancel provider setup'), {
          description: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    [analytics, deleteSetup, t]
  );

  const handleConfirmDelete = async () => {
    if (!pendingDelete) return;
    const startedAtMs = analytics.now();
    analytics.capture('onboarding/operation_started', {
      step: 'providers',
      operation: 'agent_config_delete',
    });
    try {
      setDeleting(true);
      invalidateTestRun(pendingDelete.id);
      await deleteConfig(pendingDelete.id);
      clearFailureReason(pendingDelete.id);
      setTestStatuses((prev) => {
        const { [pendingDelete.id]: _, ...rest } = prev;
        return rest;
      });
      setPendingDelete(null);
      analytics.capture('onboarding/operation_succeeded', {
        step: 'providers',
        operation: 'agent_config_delete',
        duration_ms: analytics.durationSince(startedAtMs),
      });
    } catch (error) {
      console.error('[onboarding] Failed to delete Agent configuration:', error);
      analytics.capture('onboarding/operation_failed', {
        step: 'providers',
        operation: 'agent_config_delete',
        failure_code: 'agent_config_delete_failed',
        duration_ms: analytics.durationSince(startedAtMs),
        retryable: true,
      });
      toast.error(t('agents.deleteConfigError', 'Failed to delete configuration'), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <ProvidersScreenView
        configs={localConfigs}
        setups={localSetups}
        testStatuses={testStatuses}
        testActivities={testActivities}
        failureReasons={failureReasons}
        runtimeReadiness={runtimeReadiness}
        selectedProviderId={selectedProviderId}
        noLocalMachine={!localMachine}
        localMachineId={localMachineId}
        localMachine={localMachine}
        onEdit={(config) => setDialogMode({ kind: 'edit', config })}
        onSelect={(config) => setSelectedProviderId(config.id)}
        onTest={handleTest}
        onAuthenticated={(config) => {
          clearFailureReason(config.id);
          setStatus(config.id, 'passed');
        }}
        onDelete={(config) => setPendingDelete(config)}
        onRetrySetup={handleRetrySetup}
        onDeleteSetup={handleDeleteSetup}
        onAdd={(pick) => {
          if (!pick) {
            setDialogMode({ kind: 'create' });
            return;
          }
          // Quick-add from the showcase: pre-select the provider so the dialog
          // opens straight on its config form (registry agents probe; presets go
          // straight to a token field). Names seed from the registry/preset and
          // stay editable in the dialog.
          if (pick.kind === 'preset') {
            setDialogMode({ kind: 'create', initialForm: buildPresetCreateForm(pick.presetId) });
            return;
          }
          if (pick.kind === 'builtin') {
            setDialogMode({
              kind: 'create',
              initialForm: {
                cliType: 'builtin',
                agentType: pick.agentType,
                name: getBuiltinAgentByAgentType(pick.agentType)?.displayName ?? pick.agentType,
              },
            });
            return;
          }
          const agent = REGISTRY_ACP_AGENTS.find((a) => a.id === pick.id);
          setDialogMode({
            kind: 'create',
            initialForm: {
              cliType: 'registry',
              agentType: pick.id,
              name: agent?.name ?? pick.id,
            },
          });
        }}
        onBack={onBack}
        onSkip={onSkip}
        onNext={onNext}
      />

      {dialogMode && localMachine ? (
        <AgentConfigDialog
          open={dialogOpen}
          onOpenChange={(open) => {
            if (!open) setDialogMode(null);
          }}
          mode={dialogMode}
          machine={localMachine}
          onSubmit={handleDialogSubmit}
          onRefreshCapabilities={refreshCapabilities}
          onScanPiExtensions={
            runtime
              ? ({ machineId, configId }) =>
                  runtime.requestMachinePiExtensions(machineId, { configId })
              : undefined
          }
          onCheckBinaryStatus={checkBinaryStatus}
          onInstallBinary={installBinary}
          onManagedRuntimeSelected={onManagedRuntimeSelected}
        />
      ) : null}

      <AlertDialog.Root
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>
              {t('agents.deleteConfigConfirm', 'Delete Configuration')}
            </AlertDialog.Title>
            <AlertDialog.Description>
              {t('agents.deleteConfigConfirmDescription', {
                name: pendingDelete?.name ?? '',
                defaultValue:
                  'Are you sure you want to delete "{{name}}"? This action cannot be undone.',
              })}
            </AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Footer>
            <AlertDialog.Cancel disabled={deleting}>
              {t('common.cancel', 'Cancel')}
            </AlertDialog.Cancel>
            <Button
              disabled={deleting}
              onClick={() => {
                void handleConfirmDelete();
              }}
              variant="destructive"
            >
              {deleting && <Spinner size="small" />}
              {t('common.delete', 'Delete')}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </>
  );
}

/** Seconds since `startedAtMs`, ticking only while one is supplied. */
function useElapsedSeconds(startedAtMs: number | null): number {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  useEffect(() => {
    if (startedAtMs === null) {
      setElapsedSeconds(0);
      return undefined;
    }
    const tick = (): void =>
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000)));
    tick();
    const intervalId = window.setInterval(tick, 1000);
    return () => window.clearInterval(intervalId);
  }, [startedAtMs]);
  return elapsedSeconds;
}

/**
 * The escalation tier a row's wait has reached, and the seconds behind it.
 *
 * The badge and the action both read this, so the tone the row takes and the
 * number it shows can never disagree about which tier the wait is in. Only a
 * denominator-free stage escalates: a download already answers "how much
 * longer" with a percentage, and a runtime that has failed is not waiting.
 */
function useProviderWaitEscalation(activity: ProviderTestActivity | undefined): {
  escalation: ProviderWaitEscalation;
  elapsedSeconds: number;
} {
  const percent = getProviderTestActivityPercent(activity);
  const measurable =
    activity !== undefined && percent === null && activity.phase !== 'runtime-failed';
  const elapsedSeconds = useElapsedSeconds(measurable ? (activity.startedAtMs ?? null) : null);
  return { escalation: providerWaitEscalation(elapsedSeconds), elapsedSeconds };
}

/**
 * The in-flight action for a row.
 *
 * A download has a denominator, so the button fills and reads as a percentage.
 * Every other stage — the ACP handshake above all — has none, and inventing one
 * would be a lie. Once the wait is `measured` it reports elapsed time instead,
 * which is what turns an open-ended wait into a wait the user can measure. The
 * badge beside it names the stage, so the two together read as "Starting · 14s"
 * — and, once the wait is `exceptional`, as "Taking longer · 74s".
 */
function ProviderActivityAction({
  activity,
  config,
}: {
  activity: ProviderTestActivity;
  config: AgentConfigMeta;
}) {
  const { t } = useTranslation();
  const percent = getProviderTestActivityPercent(activity);
  const runtimeFailed = activity.phase === 'runtime-failed';
  const { escalation, elapsedSeconds } = useProviderWaitEscalation(activity);
  const label = (() => {
    if (percent !== null) return `${percent}%`;
    // Never label an already-failed runtime as ongoing work while the durable
    // reason is still in flight.
    if (runtimeFailed) return t('onboarding.providers.failedAction', 'Failed');
    if (escalation !== 'normal') {
      return t('onboarding.providers.workingSeconds', '{{seconds}}s', {
        seconds: elapsedSeconds,
      });
    }
    return t('onboarding.providers.workingAction', 'Working');
  })();

  const handleCopyReport = useCallback(() => {
    const report = buildProviderWaitReport({
      agentName: config.name,
      cliType: config.cliType,
      agentType: config.agentType,
      phase: activity.phase,
      elapsedSeconds,
      percent,
      environment: collectErrorBoundaryEnvironment(),
    });
    void writeTextToClipboard(report).then((ok) => {
      if (ok) {
        toast.success(t('onboarding.providers.slowWaitCopied', 'Setup details copied'));
        return;
      }
      // Copying can be blocked (insecure context, no gesture). Say so rather
      // than leaving the user believing they have something to paste.
      console.error('[onboarding] Could not copy provider setup details to the clipboard');
      toast.error(t('onboarding.providers.slowWaitCopyFailed', 'Could not copy setup details'), {
        description: report,
      });
    });
  }, [activity.phase, config, elapsedSeconds, percent, t]);

  // The escalation's real ask is "tell someone". A wait this long ends in the
  // chat, and the three things we would have to ask for there — which stage,
  // how long, which build — are the three things the user cannot see. So the
  // exceptional tier hands them one block to paste. It is also the tier's only
  // pointer-independent affordance: the tooltip beside it is hover-only.
  const copyable = !runtimeFailed && escalation === 'exceptional';
  const copyLabel = t('onboarding.providers.slowWaitCopy', 'Copy setup details');

  // The escalation turns the pill itself into the copy control rather than
  // adding a button beside it. A second control here would widen this row's
  // action cluster past every other row's, so the status column and the name
  // column would slide sideways for exactly the row already asking for
  // attention. It stays a real focusable button, so the affordance survives
  // without a pointer.
  return (
    <ProviderProgressButton
      percent={percent}
      label={label}
      className={stylex.props(styles.fillSlot).className}
      {...(copyable
        ? {
            icon: <Copy {...stylex.props(surface.icon14)} />,
            ariaLabel: copyLabel,
            title: copyLabel,
            onClick: handleCopyReport,
          }
        : {})}
    />
  );
}

function getProviderTestActivityPercent(activity?: ProviderTestActivity): number | null {
  return activity?.phase === 'downloading-runtime' && typeof activity.percent === 'number'
    ? Math.min(100, Math.max(0, Math.round(activity.percent)))
    : null;
}

/**
 * Every provider status is one `Badge`, and the tone says which kind it is. The
 * geometry is the primitive's — one height, one padding, one corner — which is
 * what this column needed when it was five hand-built chips that read as five
 * different controls stacked on top of each other.
 */
function ProviderStatusBadge({
  status,
  activity,
  failureReason,
}: {
  status: ProviderTestStatus;
  activity?: ProviderTestActivity;
  failureReason?: string;
}) {
  const { t } = useTranslation();
  const { escalation } = useProviderWaitEscalation(activity);
  if (activity) {
    const stageLabel = (() => {
      switch (activity.phase) {
        case 'checking-runtime':
          return t('onboarding.providers.activityChecking', 'Checking');
        case 'downloading-runtime':
          return t('onboarding.providers.activityDownloading', 'Downloading');
        case 'verifying-runtime':
          return t('onboarding.providers.activityVerifying', 'Verifying');
        case 'extracting-runtime':
          return t('onboarding.providers.activityExtracting', 'Extracting');
        case 'installing-runtime':
          return t('onboarding.providers.activityInstalling', 'Installing');
        case 'probing-provider':
          return t('onboarding.providers.activityStarting', 'Starting');
        case 'runtime-failed':
          return t('onboarding.providers.activityRuntimeFailed', 'Runtime failed');
      }

      const unreachablePhase: never = activity.phase;
      throw new Error(`Unknown provider test activity phase: ${String(unreachablePhase)}`);
    })();
    // A runtime that already reported a failure must not keep wearing the
    // in-progress tone; the final response still owns the durable reason.
    const runtimeFailed = activity.phase === 'runtime-failed';
    // Second escalation. The row stops naming the stage as if this were a
    // normal run and says what is actually true — the wait left the usual
    // range — in the amber this screen already uses for "needs your
    // attention, but nothing has failed". No new progress is invented, and
    // the elapsed counter beside it keeps the wait measurable.
    const exceptional = !runtimeFailed && escalation === 'exceptional';
    // Request-scoped, exactly like the counter beside it. The badge no longer
    // names a stage here on purpose: the timer measures the whole setup, so a
    // sentence about the current stage would attach the elapsed number to work
    // that may have started a second ago. The stage still travels — in the
    // copyable report, where it is diagnostic data rather than a claim.
    const slowDetail = t(
      'onboarding.providers.slowWaitDetail',
      'Agent setup is still running. A first run may have to download and unpack the agent. You can continue — Lody keeps working on this in the background.'
    );
    const badge = (
      <Badge
        // The badge is not focusable, so the tooltip is a hover-only detail.
        // The acknowledgement itself must reach assistive tech regardless.
        aria-label={exceptional ? slowDetail : undefined}
        tone={runtimeFailed ? 'danger' : exceptional ? 'warning' : 'running'}
      >
        {exceptional ? t('onboarding.providers.activitySlow', 'Taking longer') : stageLabel}
      </Badge>
    );
    if (!exceptional) return badge;
    return (
      <Tooltip.Provider delay={200}>
        <Tooltip.Root>
          <Tooltip.Trigger render={badge} />
          <Tooltip.Content side="top">
            <div {...stylex.props(styles.tipTitle)}>
              {t('onboarding.providers.slowWaitTitle', 'This is taking longer than usual')}
            </div>
            <div {...stylex.props(styles.tipDetail)}>{slowDetail}</div>
          </Tooltip.Content>
        </Tooltip.Root>
      </Tooltip.Provider>
    );
  }
  if (status === 'passed') {
    return (
      <Badge tone="success" icon={<CheckCircle2 {...stylex.props(surface.iconFill)} />}>
        {t('onboarding.providers.statusPassed', 'Verified')}
      </Badge>
    );
  }
  if (status === 'failed') {
    const badge = (
      <Badge
        aria-label={
          failureReason
            ? t('onboarding.providers.failureReasonA11y', 'Failed: {{reason}}', {
                reason: failureReason,
              })
            : undefined
        }
        tone="danger"
        icon={<XCircle {...stylex.props(surface.iconFill)} />}
      >
        {t('onboarding.providers.statusFailed', 'Failed')}
      </Badge>
    );
    if (!failureReason) return badge;
    return (
      <Tooltip.Provider delay={200}>
        <Tooltip.Root>
          <Tooltip.Trigger render={badge} />
          <Tooltip.Content side="top">
            <div {...stylex.props(styles.tipTitle)}>
              {t('onboarding.providers.failureReasonTitle', 'Why it failed')}
            </div>
            <div {...stylex.props(styles.tipDetail)}>{failureReason}</div>
          </Tooltip.Content>
        </Tooltip.Root>
      </Tooltip.Provider>
    );
  }
  if (status === 'needs-auth') {
    return <Badge tone="warning">{t('onboarding.providers.statusNeedsAuth', 'Sign in')}</Badge>;
  }
  return <Badge>{t('onboarding.providers.statusUntested', 'Untested')}</Badge>;
}

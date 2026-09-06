import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAtomValue, useSetAtom } from 'jotai';
import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle2, ChevronDown, ChevronUp, Loader2, Plus, Trash2, XCircle } from 'lucide-react';
import {
  REGISTRY_ACP_AGENTS,
  getBuiltinAgentByAgentType,
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
import { toast } from 'sonner';
import { Button } from '@/ui/button';
import { Badge } from '@/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/ui/tooltip';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/ui/alert-dialog';
import { cn } from '@/lib/utils';
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
import {
  createProviderTestRunRegistry,
  providerTestActivityFromProgress,
  type ProviderTestActivity,
} from '../provider-test-state';
import { useOnboardingAnalytics } from '../onboarding-analytics';

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
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="lg"
            onClick={onSkip}
            className="text-muted-foreground hover:text-foreground"
          >
            {t('onboarding.providers.skip', 'Skip for now')}
          </Button>
          <OnboardingNextButton
            onClick={() => selectedProvider && onNext(selectedProvider)}
            disabled={!canProceed || selectedProvider === null}
          />
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        {noLocalMachine ? (
          <div className="flex items-center gap-3 rounded-lg border border-dashed border-border/60 bg-muted/30 p-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('onboarding.providers.waitingMachine', 'Waiting for the local agent to connect…')}
          </div>
        ) : null}

        {configs.length > 0 || setups.length > 0 ? (
          // Cap at ~4 rows; longer lists scroll. -mx-1/px-1 keeps focus rings
          // visible without clipping at the scroll edge.
          <div className="scrollbar-pro -mx-1 max-h-[calc(4*4.25rem+0.75rem*3)] overflow-y-auto overscroll-contain px-1">
            <div className="flex flex-col gap-3">
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
                  const activityPercent = getProviderTestActivityPercent(activity);
                  const selected = config.id === resolvedSelectedProviderId;
                  return (
                    <motion.div
                      key={config.id}
                      layout
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -8 }}
                      transition={{ duration: 0.25 }}
                      className={cn(
                        // Hover lives on the row, not the inner edit button,
                        // so highlighting feels like one unit even though
                        // Test/Delete are separate click targets.
                        'group flex flex-wrap items-center gap-3 rounded-lg border transition-colors',
                        selected
                          ? 'border-primary bg-primary/[0.06] ring-2 ring-primary/15'
                          : status === 'passed'
                            ? 'border-primary/40 bg-primary/[0.04] hover:bg-primary/[0.07]'
                            : 'border-border/60 bg-card/40 hover:border-border hover:bg-hover/40'
                      )}
                    >
                      <button
                        type="button"
                        disabled={noLocalMachine}
                        className={cn(
                          'flex min-w-0 flex-1 items-center gap-3 rounded-l-lg py-3 pl-3 text-left',
                          'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                          'disabled:cursor-not-allowed disabled:opacity-60'
                        )}
                        aria-pressed={selected}
                        aria-label={t('onboarding.providers.selectConfig', 'Select {{name}}', {
                          name: config.name,
                        })}
                        onClick={() => (onSelect ? onSelect(config) : onEdit(config))}
                      >
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted/40">
                          <AgentIcon
                            cliType={config.cliType}
                            agentType={config.agentType}
                            brandId={config.brandId}
                            env={config.env}
                            className="h-5 w-5"
                          />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium">{config.name}</div>
                          <div className="truncate text-xs text-muted-foreground">
                            {labelForAgent(config.cliType, config.agentType)}
                          </div>
                        </div>
                        {/* Sibling of the two-line text column, so the badge
                            centres against the whole row instead of riding the
                            name's baseline. */}
                        <ProviderStatusBadge
                          status={status}
                          activity={activity}
                          failureReason={failureReasons[config.id]}
                        />
                      </button>
                      <div className="flex shrink-0 items-center gap-1 pr-3">
                        <Button variant="ghost" size="sm" onClick={() => onEdit(config)}>
                          {t('common.edit', 'Edit')}
                        </Button>
                        {activity ? (
                          <ProviderProgressButton
                            percent={activityPercent}
                            label={
                              activityPercent !== null
                                ? `${activityPercent}%`
                                : t('onboarding.providers.workingAction', 'Working')
                            }
                          />
                        ) : status !== 'needs-auth' ? (
                          <Button
                            variant={status === 'passed' ? 'ghost' : 'outline'}
                            size="sm"
                            disabled={noLocalMachine}
                            onClick={() => onTest(config)}
                          >
                            {status === 'passed'
                              ? t('onboarding.providers.retest', 'Re-test')
                              : t('onboarding.providers.test', 'Test')}
                          </Button>
                        ) : null}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                          aria-label={t('common.delete', 'Delete')}
                          onClick={() => onDelete(config)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                      {status === 'needs-auth' ? (
                        <div className="basis-full px-3 pb-3">
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

        <button
          type="button"
          disabled={noLocalMachine}
          onClick={() => onAdd()}
          className={cn(
            'group flex items-center justify-center gap-2 rounded-lg border-2 border-dashed py-4 text-sm font-medium transition-all',
            'border-border/60 text-muted-foreground hover:border-primary/60 hover:bg-primary/[0.04] hover:text-foreground',
            'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring',
            'disabled:opacity-50 disabled:hover:border-border/60 disabled:hover:bg-transparent disabled:hover:text-muted-foreground'
          )}
        >
          <Plus className="h-4 w-4 transition-transform group-hover:rotate-90" />
          {configs.length + setups.length === 0
            ? t('onboarding.providers.addFirst', 'Add your first Agent')
            : t('onboarding.providers.addAnother', 'Add another Agent')}
        </button>

        {!noLocalMachine && !canProceed ? (
          <p className="text-center text-xs text-muted-foreground/80">
            {t(
              'onboarding.providers.needTested',
              'Add an Agent to continue, or skip and configure later.'
            )}
          </p>
        ) : null}

        <AgentShowcase disabled={noLocalMachine} onPick={onAdd} />
      </div>
    </OnboardingShell>
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
}: {
  disabled: boolean;
  onPick: (pick: ShowcasePick) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const moreCount = MORE_SHOWCASE_AGENTS.length;
  const visible = expanded
    ? [...FEATURED_SHOWCASE_AGENTS, ...MORE_SHOWCASE_AGENTS]
    : FEATURED_SHOWCASE_AGENTS;

  return (
    <div className="flex flex-col gap-3 pt-2">
      <div className="flex items-center gap-3" aria-hidden>
        <div className="h-px flex-1 bg-border/70" />
        <span className="shrink-0 text-[11px] font-medium tracking-wide text-muted-foreground/70">
          {t('onboarding.providers.moreLabel', 'Plus many more coding agents')}
        </span>
        <div className="h-px flex-1 bg-border/70" />
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {visible.map((agent) => (
          <button
            key={showcasePickKey(agent.pick)}
            type="button"
            disabled={disabled}
            title={agent.label}
            onClick={() => onPick(agent.pick)}
            className={cn(
              'group/chip inline-flex items-center gap-1.5 rounded-full border py-1 pl-1 pr-3',
              'border-border/50 bg-card/30 text-xs font-medium text-muted-foreground',
              'transition-all hover:border-primary/40 hover:bg-primary/[0.06] hover:text-foreground',
              'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring',
              'disabled:pointer-events-none disabled:opacity-50'
            )}
          >
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted/50 text-foreground/70 transition-colors group-hover/chip:bg-background group-hover/chip:text-foreground">
              <AgentIcon
                cliType={agent.icon.cliType}
                agentType={agent.icon.agentType}
                brandId={agent.icon.cliType === 'builtin' ? agent.icon.brandId : undefined}
                className="h-3.5 w-3.5"
              />
            </span>
            {agent.label}
          </button>
        ))}

        {moreCount > 0 ? (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            className={cn(
              'inline-flex items-center gap-1 rounded-full border border-dashed py-1 pl-3 pr-2.5',
              'border-border/70 bg-transparent text-xs font-medium text-muted-foreground',
              'transition-all hover:border-primary/50 hover:text-foreground',
              'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring'
            )}
          >
            {expanded ? (
              <>
                {t('onboarding.providers.showLess', 'Show less')}
                <ChevronUp className="h-3.5 w-3.5" />
              </>
            ) : (
              <>
                {t('onboarding.providers.showMore', '+{{count}} more', { count: moreCount })}
                <ChevronDown className="h-3.5 w-3.5" />
              </>
            )}
          </button>
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

  useEffect(
    () => () => {
      testRunsRef.current.invalidateAll();
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
        [config.id]: { phase: 'checking-runtime' },
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
                [config.id]: providerTestActivityFromProgress(progress),
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
          onCheckBinaryStatus={checkBinaryStatus}
          onInstallBinary={installBinary}
          onManagedRuntimeSelected={onManagedRuntimeSelected}
        />
      ) : null}

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('agents.deleteConfigConfirm', 'Delete Configuration')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('agents.deleteConfigConfirmDescription', {
                name: pendingDelete?.name ?? '',
                defaultValue:
                  'Are you sure you want to delete "{{name}}"? This action cannot be undone.',
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>
              {t('common.cancel', 'Cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              onClick={(event) => {
                event.preventDefault();
                void handleConfirmDelete();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('common.delete', 'Delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function getProviderTestActivityPercent(activity?: ProviderTestActivity): number | null {
  return activity?.phase === 'downloading-runtime' && typeof activity.percent === 'number'
    ? Math.min(100, Math.max(0, Math.round(activity.percent)))
    : null;
}

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
  if (activity) {
    const label = (() => {
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
      }

      const unreachablePhase: never = activity.phase;
      throw new Error(`Unknown provider test activity phase: ${String(unreachablePhase)}`);
    })();
    return (
      <Badge
        variant="outline"
        className="shrink-0 whitespace-nowrap border-primary/35 bg-primary/8 text-[10px] text-primary"
      >
        {label}
      </Badge>
    );
  }
  if (status === 'passed') {
    return (
      <Badge
        variant="outline"
        className="shrink-0 gap-1 whitespace-nowrap border-primary/40 bg-primary/10 text-[10px] text-primary"
      >
        <CheckCircle2 className="h-2.5 w-2.5" />
        {t('onboarding.providers.statusPassed', 'Verified')}
      </Badge>
    );
  }
  if (status === 'failed') {
    const badge = (
      <Badge
        variant="outline"
        aria-label={
          failureReason
            ? t('onboarding.providers.failureReasonA11y', 'Failed: {{reason}}', {
                reason: failureReason,
              })
            : undefined
        }
        className="shrink-0 gap-1 whitespace-nowrap border-destructive/40 text-[10px] text-destructive"
      >
        <XCircle className="h-2.5 w-2.5" />
        {t('onboarding.providers.statusFailed', 'Failed')}
      </Badge>
    );
    if (!failureReason) return badge;
    return (
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>{badge}</TooltipTrigger>
          <TooltipContent side="top" className="max-w-80 px-3 py-2">
            <div className="font-medium">
              {t('onboarding.providers.failureReasonTitle', 'Why it failed')}
            </div>
            <div className="mt-1 break-words text-xs text-muted-foreground">{failureReason}</div>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }
  if (status === 'needs-auth') {
    return (
      <Badge
        variant="outline"
        className="shrink-0 whitespace-nowrap text-[10px] text-amber-600 dark:text-amber-400"
      >
        {t('onboarding.providers.statusNeedsAuth', 'Sign in')}
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="shrink-0 whitespace-nowrap text-[10px] text-muted-foreground"
    >
      {t('onboarding.providers.statusUntested', 'Untested')}
    </Badge>
  );
}

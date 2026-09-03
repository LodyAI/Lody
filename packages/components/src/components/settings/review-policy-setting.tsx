import { useAtomValue } from 'jotai';
import { Check, Monitor, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  ACP_PLAN_PERMISSION_MODE_ID,
  DEFAULT_REVIEW_POLICY,
  getReviewPolicyFlockDocId,
  getServerNow,
  isMachineReviewerConfigUsable,
  REVIEW_STANDARDS_FILENAME,
  type AcpConfigOptionValue,
  type AgentConfigMeta,
  type MachineId,
  type MachineReviewerConfig,
  type MachineViewMeta,
  type ReviewPolicy,
} from '@lody/shared';
import { getAllAgentConfigAtom } from '@/atoms/agents';
import { reviewAgentFeatureEnabledAtom } from '@/atoms/settings';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import {
  deleteMachineReviewerConfigFromFlock,
  listMachineReviewerConfigsFromFlock,
  readReviewPolicyFromFlock,
  writeMachineReviewerConfigToFlock,
  writeReviewPolicyToFlock,
} from '@/atoms/review-policy';
import { useAcpSelectorOptions } from '@/hooks/use-acp-selector-options';
import { useIsMobile } from '@/hooks/use-mobile';
import { useMachineFlockAgentConfigsForMachineIds } from '@/hooks/use-machine-flock-agent-configs';
import { useOnlineMachineIds } from '@/hooks/use-machine-online-status';
import { useOpenSettings } from '@/hooks/use-open-settings';
import { useVisibleMachineMetas } from '@/hooks/use-visible-machine-metas';
import type { AgentSelection } from '@/components/shared/agent-selector';
import { buildAcpSelectorOptions } from '@/components/shared/acp-selector-options';
import {
  DesktopPermissionModeButton,
  DesktopRunConfigMenu,
} from '@/components/sessions/desktop-run-config-menu';
import { MobileSettingsRow, MobileSettingsSection } from '@/components/mobile/mobile-settings-row';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Switch } from '@/ui/switch';
import { Textarea } from '@/ui/textarea';
import { cn } from '@/lib/utils';
import { CompactRow, CompactSection } from './compact-layout';

/** Long enough to coalesce typing, short enough to feel saved. */
const POLICY_WRITE_DEBOUNCE_MS = 600;

const clampBudget = (value: string, min: number, max: number, fallback: number): number => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
};

const workspacePolicyOnly = (policy: ReviewPolicy): ReviewPolicy => {
  const { reviewer: _frozenReviewer, ...workspacePolicy } = policy;
  return workspacePolicy;
};

type ReviewerMachineConfigTableProps = {
  machines: readonly MachineViewMeta[];
  agentConfigs: readonly AgentConfigMeta[];
  reviewerConfigs: ReadonlyMap<MachineId, MachineReviewerConfig>;
  onlineMachineIds: ReadonlySet<MachineId>;
  loading?: boolean;
  standalone?: boolean;
  onChange: (config: MachineReviewerConfig) => void;
  onDelete: (machineId: MachineId) => void;
  onOpenAgentSettings: () => void;
};

type ReviewerMachineRowProps = Omit<
  ReviewerMachineConfigTableProps,
  'machines' | 'reviewerConfigs' | 'loading' | 'standalone'
> & {
  machine: MachineViewMeta;
  reviewerConfig: MachineReviewerConfig | undefined;
};

function ReviewerMachineRow({
  machine,
  agentConfigs,
  reviewerConfig,
  onlineMachineIds,
  onChange,
  onDelete,
  onOpenAgentSettings,
}: ReviewerMachineRowProps) {
  const { t } = useTranslation();
  const machineAgentConfigs = useMemo(
    () =>
      agentConfigs
        .filter((config) => config.machineId === machine.id)
        .sort((left, right) => left.name.localeCompare(right.name)),
    [agentConfigs, machine.id]
  );
  const selectedAgent = reviewerConfig
    ? machineAgentConfigs.find(
        (config) =>
          config.id === reviewerConfig.reviewer.agentConfigId &&
          config.agentType === reviewerConfig.reviewer.agentType
      )
    : undefined;
  const selectorOptions = useAcpSelectorOptions(
    selectedAgent
      ? {
          configId: selectedAgent.id,
          cliType: selectedAgent.cliType,
          agentType: selectedAgent.agentType,
          selectedModeId: reviewerConfig?.reviewer.modeId,
          selectedModelId: reviewerConfig?.reviewer.modelId,
          configOptionValues: reviewerConfig?.reviewer.configOptionValues,
          runtimeOverrides: selectedAgent.runtimeOverrides,
          machine,
        }
      : undefined
  );
  const safeDefaultModeId =
    selectorOptions.modeOptions.find((option) => option.value === ACP_PLAN_PERMISSION_MODE_ID)
      ?.value ?? selectorOptions.defaultModeId;
  const selectedModeId = reviewerConfig?.reviewer.modeId ?? safeDefaultModeId;
  const selectedModelId = reviewerConfig?.reviewer.modelId ?? selectorOptions.defaultModelId;
  const configured = isMachineReviewerConfigUsable(reviewerConfig, machine.id, machineAgentConfigs);
  const online = onlineMachineIds.has(machine.id);

  const commitReviewer = useCallback(
    (reviewer: MachineReviewerConfig['reviewer']) => {
      onChange({ machineId: machine.id, reviewer, updatedAt: getServerNow() });
    },
    [machine.id, onChange]
  );

  const handleAgentChange = useCallback(
    (selection: AgentSelection) => {
      const nextAgent = machineAgentConfigs.find(
        (config) => config.id === selection.agentId && config.machineId === selection.machineId
      );
      if (!nextAgent) {
        return;
      }
      const defaults = buildAcpSelectorOptions({
        configId: nextAgent.id,
        cliType: nextAgent.cliType,
        agentType: nextAgent.agentType,
        runtimeOverrides: nextAgent.runtimeOverrides,
        machine,
      });
      const defaultModeId =
        defaults.modeOptions.find((option) => option.value === ACP_PLAN_PERMISSION_MODE_ID)
          ?.value ?? defaults.defaultModeId;
      const configOptionValues = Object.fromEntries(
        defaults.configOptionSelectors.map((selector) => [selector.configId, selector.currentValue])
      );
      commitReviewer({
        agentConfigId: nextAgent.id,
        agentType: nextAgent.agentType,
        ...(defaults.modeOptions.length > 0 && defaultModeId ? { modeId: defaultModeId } : {}),
        ...(defaults.modelOptions.length > 0 && defaults.defaultModelId
          ? { modelId: defaults.defaultModelId }
          : {}),
        ...(Object.keys(configOptionValues).length > 0 ? { configOptionValues } : {}),
      });
    },
    [commitReviewer, machine, machineAgentConfigs]
  );

  const selection: AgentSelection | null = selectedAgent
    ? { agentId: selectedAgent.id, machineId: machine.id }
    : null;

  return (
    <div
      role="row"
      className="flex flex-col gap-2 px-3 py-2.5 sm:grid sm:grid-cols-[minmax(150px,0.75fr)_minmax(0,1.75fr)] sm:items-center sm:gap-4"
    >
      <div role="cell" className="flex min-w-0 items-center gap-2.5">
        <Monitor className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0">
          <p className="truncate font-medium leading-tight text-foreground">{machine.name}</p>
          <p className="truncate text-[11px] leading-tight text-muted-foreground">
            {online
              ? t('settings.review.machineOnline', 'Online')
              : t('settings.review.machineOffline', 'Offline')}
            {machine.os ? ` · ${machine.os}` : ''}
          </p>
        </div>
      </div>

      <div role="cell" className="min-w-0 sm:pl-4">
        {machineAgentConfigs.length === 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              {t('settings.review.noAgentsOnMachine', 'No agents are configured on this machine.')}
            </span>
            <div className="flex items-center gap-1">
              <Button size="sm" variant="outline" onClick={onOpenAgentSettings}>
                {t('settings.review.configureAgents', 'Configure agents')}
              </Button>
              {reviewerConfig ? (
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 text-muted-foreground"
                  title={t('settings.review.removeConfiguration', 'Remove reviewer configuration')}
                  aria-label={t(
                    'settings.review.removeConfiguration',
                    'Remove reviewer configuration'
                  )}
                  onClick={() => onDelete(machine.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <DesktopRunConfigMenu
              agentSelection={selection}
              allowedMachineIds={[machine.id]}
              availableAgentConfigs={machineAgentConfigs}
              showAgentNameInTrigger
              emptyAgentLabel={
                reviewerConfig
                  ? t('settings.review.agentUnavailable', 'Choose another reviewer')
                  : t('settings.review.chooseReviewer', 'Choose reviewer')
              }
              onAgentConfigChange={handleAgentChange}
              modelOptions={selectorOptions.modelOptions}
              selectedModelId={selectedModelId}
              onModelChange={
                reviewerConfig
                  ? (modelId) => commitReviewer({ ...reviewerConfig.reviewer, modelId })
                  : undefined
              }
              configOptionSelectors={selectorOptions.configOptionSelectors}
              configOptionValues={reviewerConfig?.reviewer.configOptionValues}
              onConfigOptionChange={
                reviewerConfig
                  ? (configId: string, value: AcpConfigOptionValue) =>
                      commitReviewer({
                        ...reviewerConfig.reviewer,
                        configOptionValues: {
                          ...reviewerConfig.reviewer.configOptionValues,
                          [configId]: value,
                        },
                      })
                  : undefined
              }
            />

            {selectedAgent ? (
              <DesktopPermissionModeButton
                modeOptions={selectorOptions.modeOptions}
                selectedModeId={selectedModeId}
                onModeChange={(modeId) => {
                  if (reviewerConfig) {
                    commitReviewer({ ...reviewerConfig.reviewer, modeId });
                  }
                }}
                configOptionSelectors={selectorOptions.configOptionSelectors}
                configOptionValues={reviewerConfig?.reviewer.configOptionValues}
                onConfigOptionChange={(configId, value) => {
                  if (reviewerConfig) {
                    commitReviewer({
                      ...reviewerConfig.reviewer,
                      configOptionValues: {
                        ...reviewerConfig.reviewer.configOptionValues,
                        [configId]: value,
                      },
                    });
                  }
                }}
              />
            ) : null}

            <div className="ml-auto flex items-center gap-1">
              <span
                className={cn(
                  'inline-flex items-center gap-1 text-[11px]',
                  configured ? 'text-muted-foreground' : 'text-status-warning'
                )}
              >
                {configured ? <Check className="h-3 w-3" aria-hidden="true" /> : null}
                {configured
                  ? t('settings.review.configured', 'Configured')
                  : reviewerConfig
                    ? t('settings.review.agentRemoved', 'Reviewer unavailable')
                    : t('settings.review.notConfigured', 'Not configured')}
              </span>

              {reviewerConfig ? (
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 text-muted-foreground"
                  title={t('settings.review.removeConfiguration', 'Remove reviewer configuration')}
                  aria-label={t(
                    'settings.review.removeConfiguration',
                    'Remove reviewer configuration'
                  )}
                  onClick={() => onDelete(machine.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Presentational table kept exportable so Storybook can render the real UI. */
export function ReviewerMachineConfigTable({
  machines,
  agentConfigs,
  reviewerConfigs,
  onlineMachineIds,
  loading = false,
  standalone = false,
  onChange,
  onDelete,
  onOpenAgentSettings,
}: ReviewerMachineConfigTableProps) {
  const { t } = useTranslation();

  return (
    <div
      role="table"
      aria-label={t('settings.review.machineTableLabel', 'Reviewer configuration by machine')}
      className={cn(
        'divide-y divide-border/60 overflow-hidden',
        standalone && 'mx-3 rounded-2xl border border-border/40 bg-card'
      )}
    >
      <div
        role="row"
        className="hidden grid-cols-[minmax(150px,0.75fr)_minmax(0,1.75fr)] gap-4 bg-muted/25 px-3 py-1.5 text-[11px] font-medium text-muted-foreground sm:grid"
      >
        <div role="columnheader">{t('settings.review.machineColumn', 'Machine')}</div>
        <div role="columnheader" className="pl-4">
          {t('settings.review.reviewerColumn', 'Reviewer agent')}
        </div>
      </div>

      {loading ? (
        <div className="px-3 py-4 text-center text-xs text-muted-foreground">
          {t('settings.review.loadingMachines', 'Loading reviewer configurations…')}
        </div>
      ) : machines.length === 0 ? (
        <div className="px-3 py-4 text-center text-xs text-muted-foreground">
          {t('settings.review.noMachines', 'No machines are available in this workspace.')}
        </div>
      ) : (
        machines.map((machine) => (
          <ReviewerMachineRow
            key={machine.id}
            machine={machine}
            agentConfigs={agentConfigs}
            reviewerConfig={reviewerConfigs.get(machine.id)}
            onlineMachineIds={onlineMachineIds}
            onChange={onChange}
            onDelete={onDelete}
            onOpenAgentSettings={onOpenAgentSettings}
          />
        ))
      )}
    </div>
  );
}

type PolicyField = {
  key: string;
  label: string;
  helper: ReactNode;
  control: ReactNode;
  stack?: boolean;
};

/**
 * Workspace review rules plus a concrete reviewer configuration for every
 * visible machine. A run freezes both pieces when it is authorized.
 */
export function ReviewPolicySection() {
  const { t } = useTranslation();
  const enabled = useAtomValue(reviewAgentFeatureEnabledAtom);
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const allAgentConfigs = useAtomValue(getAllAgentConfigAtom);
  const onlineMachineIds = useOnlineMachineIds();
  const isMobile = useIsMobile();
  const { openSettings } = useOpenSettings();
  const { machines, isLoading: machinesLoading } = useVisibleMachineMetas();
  const machineList = useMemo(
    () => [...machines.values()].sort((left, right) => left.name.localeCompare(right.name)),
    [machines]
  );
  const machineIds = useMemo(
    () => (enabled ? machineList.map((machine) => machine.id) : []),
    [enabled, machineList]
  );
  useMachineFlockAgentConfigsForMachineIds(machineIds);

  const [policy, setPolicy] = useState<ReviewPolicy | null>(null);
  const [reviewerConfigs, setReviewerConfigs] = useState<Map<MachineId, MachineReviewerConfig>>(
    new Map()
  );
  const [reviewerConfigsLoading, setReviewerConfigsLoading] = useState(true);

  useEffect(() => {
    if (!enabled || !runtime) {
      setPolicy(null);
      setReviewerConfigs(new Map());
      setReviewerConfigsLoading(false);
      return undefined;
    }
    // Avoid briefly showing (or editing) the previous workspace's machine
    // rows while this workspace's review Flock is opening.
    setPolicy(null);
    setReviewerConfigs(new Map());
    setReviewerConfigsLoading(true);
    let cancelled = false;
    let unsubscribeFlock: (() => void) | null = null;
    let unsubscribeRoom: (() => void) | null = null;

    const load = async () => {
      const [loadedPolicy, loadedReviewerConfigs] = await Promise.all([
        readReviewPolicyFromFlock(runtime),
        listMachineReviewerConfigsFromFlock(runtime),
      ]);
      if (cancelled) {
        return;
      }
      setPolicy(workspacePolicyOnly(loadedPolicy));
      setReviewerConfigs(loadedReviewerConfigs);
      setReviewerConfigsLoading(false);
    };

    void (async () => {
      try {
        const handle = await runtime.repo.openFlockDoc(
          getReviewPolicyFlockDocId(runtime.workspaceId)
        );
        if (cancelled) {
          return;
        }
        await load();
        unsubscribeFlock = handle.flock.subscribe(() => {
          void load();
        });
        const subscription = await handle.joinRoom();
        if (cancelled) {
          subscription.unsubscribe();
          return;
        }
        unsubscribeRoom = () => subscription.unsubscribe();
        await subscription.firstSyncedWithRemote;
        await load();
      } catch {
        if (!cancelled) {
          setReviewerConfigsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      unsubscribeFlock?.();
      unsubscribeRoom?.();
    };
  }, [enabled, runtime]);

  // Each policy write is a Flock row put plus a sync, so persisting per
  // keystroke in the requirements textarea would put one on the wire per char.
  const pendingWrite = useRef<{
    timeout: ReturnType<typeof setTimeout>;
    flush: () => void;
  } | null>(null);
  useEffect(
    () => () => {
      const pending = pendingWrite.current;
      if (!pending) return;
      clearTimeout(pending.timeout);
      pendingWrite.current = null;
      pending.flush();
    },
    []
  );

  const persist = useCallback(
    (next: ReviewPolicy) => {
      const workspacePolicy = workspacePolicyOnly(next);
      setPolicy(workspacePolicy);
      if (!runtime) {
        return;
      }
      if (pendingWrite.current) {
        clearTimeout(pendingWrite.current.timeout);
      }
      const flush = () => {
        void writeReviewPolicyToFlock(runtime, workspacePolicy);
      };
      const timeout = setTimeout(() => {
        if (pendingWrite.current?.timeout !== timeout) return;
        pendingWrite.current = null;
        flush();
      }, POLICY_WRITE_DEBOUNCE_MS);
      pendingWrite.current = { timeout, flush };
    },
    [runtime]
  );

  const persistReviewerConfig = useCallback(
    (next: MachineReviewerConfig) => {
      setReviewerConfigs((previous) => new Map(previous).set(next.machineId, next));
      if (!runtime) {
        return;
      }
      void writeMachineReviewerConfigToFlock(runtime, next).catch(() => {
        toast.error(t('settings.review.saveFailed', 'Could not save reviewer configuration.'));
        void listMachineReviewerConfigsFromFlock(runtime).then(setReviewerConfigs);
      });
    },
    [runtime, t]
  );

  const deleteReviewerConfig = useCallback(
    (machineId: MachineId) => {
      setReviewerConfigs((previous) => {
        const next = new Map(previous);
        next.delete(machineId);
        return next;
      });
      if (!runtime) {
        return;
      }
      void deleteMachineReviewerConfigFromFlock(runtime, machineId).catch(() => {
        toast.error(t('settings.review.saveFailed', 'Could not save reviewer configuration.'));
        void listMachineReviewerConfigsFromFlock(runtime).then(setReviewerConfigs);
      });
    },
    [runtime, t]
  );

  if (!enabled) {
    return null;
  }

  const current = policy ?? DEFAULT_REVIEW_POLICY;
  const fields: PolicyField[] = [
    {
      key: 'requirements',
      label: t('settings.review.requirements', 'Review requirements'),
      helper: t(
        'settings.review.requirementsHelper',
        `Applies to every repository. Repository-specific rules belong in ${REVIEW_STANDARDS_FILENAME}, which wins on conflict.`
      ),
      stack: true,
      control: (
        <Textarea
          className="min-h-20 w-full text-xs sm:w-72"
          value={current.requirements ?? ''}
          placeholder={t(
            'settings.review.requirementsPlaceholder',
            'e.g. Flag any new dependency. Require tests for bug fixes.'
          )}
          onChange={(event) => persist({ ...current, requirements: event.target.value })}
        />
      ),
    },
    {
      key: 'review-rounds',
      label: t('settings.review.reviewRounds', 'Review rounds'),
      helper: t(
        'settings.review.reviewRoundsHelper',
        'How many times the reviewer may hand work back before stopping and asking you.'
      ),
      control: (
        <Input
          type="number"
          min={1}
          max={20}
          className="h-8 w-20"
          value={current.budget.reviewRounds}
          onChange={(event) =>
            persist({
              ...current,
              budget: {
                ...current.budget,
                reviewRounds: clampBudget(event.target.value, 1, 20, current.budget.reviewRounds),
              },
            })
          }
        />
      ),
    },
    {
      key: 'ci-fixes',
      label: t('settings.review.ciFixAttempts', 'CI fix attempts'),
      helper: t(
        'settings.review.ciFixAttemptsHelper',
        'Counted separately from review rounds, so flaky CI cannot use up the review budget.'
      ),
      control: (
        <Input
          type="number"
          min={0}
          max={10}
          className="h-8 w-20"
          value={current.budget.ciFixAttempts}
          onChange={(event) =>
            persist({
              ...current,
              budget: {
                ...current.budget,
                ciFixAttempts: clampBudget(event.target.value, 0, 10, current.budget.ciFixAttempts),
              },
            })
          }
        />
      ),
    },
    {
      key: 'conflicts',
      label: t('settings.review.conflictAttempts', 'Conflict attempts'),
      helper: t(
        'settings.review.conflictAttemptsHelper',
        'How many times the session may be asked to resolve conflicts with the base branch.'
      ),
      control: (
        <Input
          type="number"
          min={0}
          max={10}
          className="h-8 w-20"
          value={current.budget.conflictAttempts}
          onChange={(event) =>
            persist({
              ...current,
              budget: {
                ...current.budget,
                conflictAttempts: clampBudget(
                  event.target.value,
                  0,
                  10,
                  current.budget.conflictAttempts
                ),
              },
            })
          }
        />
      ),
    },
    {
      key: 'pr-comment',
      label: t('settings.review.postPrComment', 'Comment on the pull request'),
      helper: t(
        'settings.review.postPrCommentHelper',
        'Post a short summary on GitHub. Individual findings stay in Lody, where you can act on them.'
      ),
      control: (
        <Switch
          checked={current.postPrComment}
          onCheckedChange={(checked) => persist({ ...current, postPrComment: checked })}
          aria-label={t('settings.review.postPrComment', 'Comment on the pull request')}
        />
      ),
    },
    {
      key: 'protected-paths',
      label: t('settings.review.protectedPaths', 'Protected paths'),
      helper: t(
        'settings.review.protectedPathsHelper',
        'Branches touching these are never merged automatically. End with / to match a directory.'
      ),
      stack: true,
      control: (
        <Input
          className="h-8 w-full sm:w-72"
          value={current.protectedPaths.join(', ')}
          onChange={(event) =>
            persist({
              ...current,
              protectedPaths: event.target.value
                .split(',')
                .map((entry) => entry.trim())
                .filter(Boolean),
            })
          }
        />
      ),
    },
  ];

  const table = (
    <ReviewerMachineConfigTable
      machines={machineList}
      agentConfigs={allAgentConfigs}
      reviewerConfigs={reviewerConfigs}
      onlineMachineIds={onlineMachineIds}
      loading={machinesLoading || reviewerConfigsLoading}
      standalone={isMobile}
      onChange={persistReviewerConfig}
      onDelete={deleteReviewerConfig}
      onOpenAgentSettings={() => openSettings('agents')}
    />
  );

  if (isMobile) {
    return (
      <>
        <MobileSettingsSection
          title={t('settings.review.title', 'Review agent')}
          description={t(
            'settings.review.machineConfigHelper',
            'Choose the reviewer used by sessions on each machine.'
          )}
          noCard
        >
          {table}
        </MobileSettingsSection>
        <MobileSettingsSection title={t('settings.review.behaviorTitle', 'Review behavior')}>
          {fields.map((field, index) => (
            <MobileSettingsRow
              key={field.key}
              label={field.label}
              helper={field.helper}
              stack={field.stack}
              hasDivider={index > 0}
            >
              {field.control}
            </MobileSettingsRow>
          ))}
        </MobileSettingsSection>
      </>
    );
  }

  return (
    <CompactSection
      title={t('settings.review.title', 'Review agent')}
      description={t(
        'settings.review.machineConfigHelper',
        'Choose the reviewer used by sessions on each machine.'
      )}
    >
      {table}
      {fields.map((field) => (
        <CompactRow
          key={field.key}
          label={field.label}
          helper={field.helper}
          alignTop={field.stack}
        >
          {field.control}
        </CompactRow>
      ))}
    </CompactSection>
  );
}

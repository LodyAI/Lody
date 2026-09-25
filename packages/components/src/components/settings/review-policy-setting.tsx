import { useAtomValue } from 'jotai';
import { Check, Monitor, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import { toast } from '@/lib/toast';
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
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { NumberField } from '@lody/ui/number-field';
import { Switch } from '@lody/ui/switch';
import { Textarea } from '@lody/ui/textarea';
import { CompactRow, CompactSection } from './compact-layout';
import { settingsSurface as surface } from './surface';
import { settingsType as type } from './type.stylex';

/** Long enough to coalesce typing, short enough to feel saved. */
const POLICY_WRITE_DEBOUNCE_MS = 600;

const WIDE = '@media (min-width: 640px)';
const LINE = `inset 0 1px 0 ${colors.separator}`;
const COLUMNS = 'minmax(150px, 0.75fr) minmax(0, 1.75fr)';

const styles = stylex.create({
  /** Mobile draws the table as its own card, inset from the screen edge. */
  standalone: { marginInline: space[3] },
  /** Every row but the first is ruled from the one above. */
  ruled: { boxShadow: LINE },
  /**
   * The first machine row sits under the column heads, which only show on a
   * wide panel: a line above it there, none on a narrow one.
   */
  ruledWide: { boxShadow: { default: 'none', [WIDE]: LINE } },
  head: {
    display: { default: 'none', [WIDE]: 'grid' },
    gridTemplateColumns: COLUMNS,
    gap: space[4],
    paddingInline: space[4],
    paddingBlock: space[1.5],
    fontSize: type.caption,
    fontWeight: 400,
    color: colors.secondaryLabel,
  },
  row: {
    display: { default: 'flex', [WIDE]: 'grid' },
    flexDirection: 'column',
    gridTemplateColumns: { default: null, [WIDE]: COLUMNS },
    alignItems: { default: 'stretch', [WIDE]: 'center' },
    gap: { default: space[2], [WIDE]: space[4] },
    paddingInline: space[4],
    paddingBlock: '8px',
  },
  machine: { display: 'flex', minWidth: 0, alignItems: 'center', gap: '10px' },
  machineIcon: { width: '16px', height: '16px', flexShrink: 0, color: colors.tertiaryLabel },
  machineText: { minWidth: 0 },
  truncate: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  machineName: { margin: 0, fontWeight: 400, lineHeight: type.leading, color: colors.label },
  machineMeta: { margin: 0, fontSize: type.caption, lineHeight: type.leading, color: colors.secondaryLabel },
  reviewerCell: { minWidth: 0, paddingInlineStart: { default: 0, [WIDE]: space[4] } },
  noAgents: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[2],
  },
  noAgentsText: { fontSize: type.caption, color: colors.secondaryLabel },
  actions: { display: 'flex', alignItems: 'center', gap: space[1] },
  actionsEnd: { marginInlineStart: 'auto' },
  pickers: {
    display: 'flex',
    minWidth: 0,
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space[1.5],
  },
  status: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[1],
    fontSize: type.caption,
    color: colors.secondaryLabel,
  },
  statusWarning: { color: colors.warning },
  statusIcon: { width: '12px', height: '12px', flexShrink: 0 },
  glyph: { width: '100%', height: '100%' },
  /** A text value takes a fixed column on a wide panel and the row on a narrow one. */
  wideField: { width: { default: '100%', [WIDE]: '288px' } },
  numberField: { width: '80px' },
});

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
  /** The first row: under the column heads on a wide panel, the top of the card on a narrow one. */
  first: boolean;
};

function ReviewerMachineRow({
  machine,
  first,
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
    <div role="row" {...stylex.props(styles.row, first ? styles.ruledWide : styles.ruled)}>
      <div role="cell" {...stylex.props(styles.machine)}>
        <Monitor {...stylex.props(styles.machineIcon)} aria-hidden="true" />
        <div {...stylex.props(styles.machineText)}>
          <p {...stylex.props(styles.machineName, styles.truncate)}>{machine.name}</p>
          <p {...stylex.props(styles.machineMeta, styles.truncate)}>
            {online
              ? t('settings.review.machineOnline', 'Online')
              : t('settings.review.machineOffline', 'Offline')}
            {machine.os ? ` · ${machine.os}` : ''}
          </p>
        </div>
      </div>

      <div role="cell" {...stylex.props(styles.reviewerCell)}>
        {machineAgentConfigs.length === 0 ? (
          <div {...stylex.props(styles.noAgents)}>
            <span {...stylex.props(styles.noAgentsText)}>
              {t('settings.review.noAgentsOnMachine', 'No agents are configured on this machine.')}
            </span>
            <div {...stylex.props(styles.actions)}>
              <Button variant="secondary" size="small" onClick={onOpenAgentSettings}>
                {t('settings.review.configureAgents', 'Configure agents')}
              </Button>
              {reviewerConfig ? (
                <Button
                  type="button"
                  variant="ghost"
                  title={t('settings.review.removeConfiguration', 'Remove reviewer configuration')}
                  aria-label={t(
                    'settings.review.removeConfiguration',
                    'Remove reviewer configuration'
                  )}
                  size="small"
                  icon
                  onClick={() => onDelete(machine.id)}
                >
                  <Trash2 {...stylex.props(styles.glyph)} />
                </Button>
              ) : null}
            </div>
          </div>
        ) : (
          <div {...stylex.props(styles.pickers)}>
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

            <div {...stylex.props(styles.actions, styles.actionsEnd)}>
              <span {...stylex.props(styles.status, !configured && styles.statusWarning)}>
                {configured ? (
                  <Check {...stylex.props(styles.statusIcon)} aria-hidden="true" />
                ) : null}
                {configured
                  ? t('settings.review.configured', 'Configured')
                  : reviewerConfig
                    ? t('settings.review.agentRemoved', 'Reviewer unavailable')
                    : t('settings.review.notConfigured', 'Not configured')}
              </span>

              {reviewerConfig ? (
                <Button
                  type="button"
                  variant="ghost"
                  title={t('settings.review.removeConfiguration', 'Remove reviewer configuration')}
                  aria-label={t(
                    'settings.review.removeConfiguration',
                    'Remove reviewer configuration'
                  )}
                  size="small"
                  icon
                  onClick={() => onDelete(machine.id)}
                >
                  <Trash2 {...stylex.props(styles.glyph)} />
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
      {...stylex.props(standalone && surface.card, standalone && styles.standalone)}
    >
      <div role="row" {...stylex.props(styles.head)}>
        <div role="columnheader">{t('settings.review.machineColumn', 'Machine')}</div>
        <div role="columnheader" {...stylex.props(styles.reviewerCell)}>
          {t('settings.review.reviewerColumn', 'Reviewer agent')}
        </div>
      </div>

      {loading ? (
        <p {...stylex.props(surface.cardNote, styles.ruledWide)}>
          {t('settings.review.loadingMachines', 'Loading reviewer configurations…')}
        </p>
      ) : machines.length === 0 ? (
        <p {...stylex.props(surface.cardNote, styles.ruledWide)}>
          {t('settings.review.noMachines', 'No machines are available in this workspace.')}
        </p>
      ) : (
        machines.map((machine, index) => (
          <ReviewerMachineRow
            key={machine.id}
            machine={machine}
            first={index === 0}
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
        <div {...stylex.props(styles.wideField)}>
          <Textarea
            value={current.requirements ?? ''}
            placeholder={t(
              'settings.review.requirementsPlaceholder',
              'e.g. Flag any new dependency. Require tests for bug fixes.'
            )}
            onChange={(event) => persist({ ...current, requirements: event.target.value })}
          />
        </div>
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
        <NumberField.Root
          {...stylex.props(styles.numberField)}
          value={current.budget.reviewRounds}
          min={1}
          max={20}
          onValueChange={(value) => {
            // The field hands back a clamped number, or null while the box is
            // empty mid-edit; only a number is worth persisting.
            if (value == null) return;
            persist({
              ...current,
              budget: { ...current.budget, reviewRounds: value },
            });
          }}
        >
          <NumberField.Input aria-label={t('settings.review.reviewRounds', 'Review rounds')} />
        </NumberField.Root>
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
        <NumberField.Root
          {...stylex.props(styles.numberField)}
          value={current.budget.ciFixAttempts}
          min={0}
          max={10}
          onValueChange={(value) => {
            // The field hands back a clamped number, or null while the box is
            // empty mid-edit; only a number is worth persisting.
            if (value == null) return;
            persist({
              ...current,
              budget: { ...current.budget, ciFixAttempts: value },
            });
          }}
        >
          <NumberField.Input aria-label={t('settings.review.ciFixAttempts', 'CI fix attempts')} />
        </NumberField.Root>
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
        <NumberField.Root
          {...stylex.props(styles.numberField)}
          value={current.budget.conflictAttempts}
          min={0}
          max={10}
          onValueChange={(value) => {
            // The field hands back a clamped number, or null while the box is
            // empty mid-edit; only a number is worth persisting.
            if (value == null) return;
            persist({
              ...current,
              budget: { ...current.budget, conflictAttempts: value },
            });
          }}
        >
          <NumberField.Input
            aria-label={t('settings.review.conflictAttempts', 'Conflict attempts')}
          />
        </NumberField.Root>
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
        <div {...stylex.props(styles.wideField)}>
          <Input
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
        </div>
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

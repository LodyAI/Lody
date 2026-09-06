import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAtomValue } from 'jotai';
import { v4 as uuidv4 } from 'uuid';
import { FolderGit2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  buildInitialHistoryEntry,
  getServerNow,
  type AgentConfigId,
  type AgentConfigMeta,
  type LocalProjectId,
  type ProjectRef,
  type SessionId,
} from '@lody/shared';
import { userAtom } from '@/atoms';
import { getAllAgentConfigAtom } from '@/atoms/agents';
import type { DesktopOnboardingProjectSelection } from '@/atoms/onboarding';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { useSessionActions } from '@/hooks/use-session-actions';
import { buildAgentPrompt } from '@/lib';
import { cn } from '@/lib/utils';
import { AgentIcon } from '@/components/icons/agent-icon';
import { Button } from '@/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/select';
import { Textarea } from '@/ui/textarea';
import { getFirstTaskPrimaryAction } from '../first-task-primary-action';
import { OnboardingBackButton, OnboardingNextButton, OnboardingShell } from '../onboarding-shell';
import { useOnboardingAnalytics } from '../onboarding-analytics';

export function getFirstTaskAgentConfigs(
  configs: readonly AgentConfigMeta[],
  project: DesktopOnboardingProjectSelection
): AgentConfigMeta[] {
  if (project.kind !== 'local') return [];
  return configs
    .filter((candidate) => candidate.machineId === project.machineId)
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

export function getSelectedFirstTaskAgentConfig(
  availableConfigs: readonly AgentConfigMeta[],
  agentConfigId: AgentConfigId
): AgentConfigMeta | null {
  return availableConfigs.find((candidate) => candidate.id === agentConfigId) ?? null;
}

export function FirstTaskScreen({
  agentConfigId,
  project,
  onBack,
  onAgentConfigChange,
  onSkip,
  onContinue,
}: {
  agentConfigId: AgentConfigId;
  project: DesktopOnboardingProjectSelection;
  onBack: () => void;
  onAgentConfigChange: (config: AgentConfigMeta) => void;
  onSkip: () => void;
  onContinue: () => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const analytics = useOnboardingAnalytics();
  const user = useAtomValue(userAtom);
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const configs = useAtomValue(getAllAgentConfigAtom);
  const { startSession, requestSessionDispatch } = useSessionActions();
  const availableConfigs = useMemo(
    () => getFirstTaskAgentConfigs(configs, project),
    [configs, project]
  );
  const config: AgentConfigMeta | null = useMemo(
    () => getSelectedFirstTaskAgentConfig(availableConfigs, agentConfigId),
    [agentConfigId, availableConfigs]
  );
  const seedPrompts = useMemo(
    () => [
      t('onboarding.firstTask.seedExplore', 'Walk me through how this codebase is organized.'),
      t('onboarding.firstTask.seedTests', 'Find the test setup and explain how to run it.'),
      t('onboarding.firstTask.seedReadme', 'Summarize the main entry points in this project.'),
    ],
    [t]
  );
  const [prompt, setPrompt] = useState(seedPrompts[0] ?? '');
  const [startRequested, setStartRequested] = useState(false);
  const canStartFirstTask =
    project.kind === 'local' &&
    config !== null &&
    config.machineId === project.machineId &&
    runtime !== null &&
    user !== null;
  const hasPrompt = prompt.trim().length > 0;
  const canCreateSession = canStartFirstTask && hasPrompt;
  const primaryAction = getFirstTaskPrimaryAction({
    canStartFirstTask,
    hasPrompt,
    startRequested,
  });

  const handleSubmit = useCallback(() => {
    if (!canCreateSession || startRequested || project.kind !== 'local' || !config || !user) {
      return;
    }
    const machineId = project.machineId;
    const trimmedPrompt = prompt.trim();
    setStartRequested(true);

    void (async () => {
      // Entering the product is the primary transaction. Start the optional
      // Session only after navigation succeeds, never as a prerequisite for it.
      const entered = await onContinue();
      if (!entered) {
        setStartRequested(false);
        return;
      }
      const sessionStartedAtMs = analytics.now();
      analytics.capture('onboarding/operation_started', {
        step: 'firstTask',
        operation: 'first_session_create',
      });
      try {
        const projectRef: ProjectRef = {
          kind: 'local',
          localProjectId: project.localProjectId as LocalProjectId,
        };
        const entry = buildInitialHistoryEntry({
          userId: user.id,
          timestamp: new Date(getServerNow()).toISOString(),
          cliType: config.cliType,
          agentType: config.agentType,
          prompt: buildAgentPrompt(trimmedPrompt, config.prompt ?? ''),
          inputBlocks: undefined,
        });
        if (!entry) throw new Error('Could not build the first turn');
        const result = await startSession(
          {
            sessionId: uuidv4() as SessionId,
            userId: user.id,
            cliType: config.cliType,
            agentType: config.agentType,
            customAcp: config.customAcp,
            runtimeOverrides: config.runtimeOverrides,
            machineId,
            agentConfigId: config.id,
            env: config.env,
            project: projectRef,
            title: trimmedPrompt.slice(0, 50),
            titleSource: 'draft',
          },
          entry
        );
        analytics.capture('onboarding/operation_succeeded', {
          step: 'firstTask',
          operation: 'first_session_create',
          duration_ms: analytics.durationSince(sessionStartedAtMs),
        });
        const dispatchStartedAtMs = analytics.now();
        analytics.capture('onboarding/operation_started', {
          step: 'firstTask',
          operation: 'first_session_dispatch',
        });
        void requestSessionDispatch(result.sessionId, result.historyEntry.id, {
          inputConfig: result.historyEntry.inputConfig,
          machineId,
        }).then(
          () => {
            analytics.capture('onboarding/operation_succeeded', {
              step: 'firstTask',
              operation: 'first_session_dispatch',
              duration_ms: analytics.durationSince(dispatchStartedAtMs),
            });
          },
          (dispatchError: unknown) => {
            console.error('Failed to accelerate the first onboarding session', dispatchError);
            analytics.capture('onboarding/operation_failed', {
              step: 'firstTask',
              operation: 'first_session_dispatch',
              failure_code: 'first_session_dispatch_failed',
              duration_ms: analytics.durationSince(dispatchStartedAtMs),
              retryable: false,
            });
          }
        );
      } catch (submitError) {
        console.error('Failed to start the first onboarding session', submitError);
        analytics.capture('onboarding/operation_failed', {
          step: 'firstTask',
          operation: 'first_session_create',
          failure_code: 'first_session_create_failed',
          duration_ms: analytics.durationSince(sessionStartedAtMs),
          retryable: false,
        });
        toast.error(t('onboarding.firstTask.startFailed', 'The first session could not start.'), {
          description: submitError instanceof Error ? submitError.message : String(submitError),
        });
      }
    })();
  }, [
    analytics,
    canCreateSession,
    config,
    onContinue,
    project,
    prompt,
    requestSessionDispatch,
    startSession,
    startRequested,
    t,
    user,
  ]);

  return (
    <OnboardingShell
      stepKey="firstTask"
      title={
        primaryAction.kind === 'run'
          ? t('onboarding.firstTask.title', 'Start your first session')
          : t('onboarding.firstTask.continueTitle', 'Continue to Lody')
      }
      description={
        primaryAction.kind === 'run'
          ? t(
              'onboarding.firstTask.description',
              'This creates a real session against the project and agent you selected.'
            )
          : t(
              'onboarding.firstTask.continueDescription',
              'Your first task is not ready yet. You can finish setup later from Settings.'
            )
      }
      previewIdentity={{
        projectName: project.name,
        ...(config
          ? {
              agentName: config.name,
              agentType: config.agentType,
              agentCliType: config.cliType,
            }
          : {}),
      }}
      previewState={{
        agentStatus: config ? 'ready' : 'preparing',
        projectStatus: 'ready',
        promptValue: prompt,
        conversationStatus: startRequested ? 'starting' : prompt.trim() ? 'draft' : 'empty',
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
            {t('onboarding.firstTask.skip', 'Skip for now')}
          </Button>
          <OnboardingNextButton
            finish
            onClick={primaryAction.kind === 'run' ? handleSubmit : onContinue}
            disabled={primaryAction.disabled}
            loading={primaryAction.loading}
            label={
              primaryAction.kind === 'run'
                ? t('onboarding.firstTask.run', 'Run first task')
                : t('onboarding.firstTask.enter', 'Enter Lody')
            }
          />
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/20 px-4 py-3">
          <FolderGit2 className="size-5 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{project.name}</div>
            <div className="truncate text-xs text-muted-foreground">
              {t('onboarding.firstTask.project', 'Project')}
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="onboarding-first-task-agent"
            className="text-xs font-medium text-slate-700"
          >
            {t('onboarding.firstTask.agent', 'Agent')}
          </label>
          <Select
            value={config?.id}
            onValueChange={(value) => {
              const next = availableConfigs.find((candidate) => candidate.id === value);
              if (!next) return;
              onAgentConfigChange(next);
            }}
            disabled={availableConfigs.length === 0}
          >
            <SelectTrigger
              id="onboarding-first-task-agent"
              aria-label={t('onboarding.firstTask.agent', 'Agent')}
              className="h-11"
            >
              <SelectValue placeholder={t('onboarding.firstTask.selectAgent', 'Select an Agent')}>
                {config ? (
                  <span className="flex min-w-0 items-center gap-2">
                    <AgentIcon
                      cliType={config.cliType}
                      agentType={config.agentType}
                      brandId={config.brandId}
                      env={config.env}
                      className="size-4 shrink-0"
                    />
                    <span className="truncate">{config.name}</span>
                  </span>
                ) : undefined}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {availableConfigs.map((candidate) => (
                <SelectItem key={candidate.id} value={candidate.id}>
                  <span className="flex min-w-0 items-center gap-2">
                    <AgentIcon
                      cliType={candidate.cliType}
                      agentType={candidate.agentType}
                      brandId={candidate.brandId}
                      env={candidate.env}
                      className="size-4 shrink-0"
                    />
                    <span className="truncate">{candidate.name}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!config ? (
            <p className="text-xs text-muted-foreground">
              {t(
                'onboarding.firstTask.agentUnavailable',
                'The selected Agent is no longer available on this machine.'
              )}
            </p>
          ) : null}
        </div>
        <Textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          rows={4}
          placeholder={t('onboarding.firstTask.promptPlaceholder', 'What should Lody do first?')}
        />
        <div className="flex flex-wrap gap-2">
          {seedPrompts.map((seed) => (
            <button
              key={seed}
              type="button"
              onClick={() => setPrompt(seed)}
              className={cn(
                'rounded-full border border-border px-3 py-1 text-xs text-muted-foreground',
                'hover:bg-muted hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring'
              )}
            >
              {seed}
            </button>
          ))}
        </div>
      </div>
    </OnboardingShell>
  );
}

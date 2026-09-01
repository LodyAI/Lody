import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAtomValue } from 'jotai';
import { v4 as uuidv4 } from 'uuid';
import { FolderGit2 } from 'lucide-react';
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
import { currentWorkspaceSlugAtom } from '@/atoms/workspace-context';
import { useSessionActions } from '@/hooks/use-session-actions';
import { buildAgentPrompt } from '@/lib';
import { cn } from '@/lib/utils';
import { AgentIcon } from '@/components/icons/agent-icon';
import { Button } from '@/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/select';
import { Textarea } from '@/ui/textarea';
import { getFirstTaskPrimaryAction } from '../first-task-primary-action';
import { OnboardingBackButton, OnboardingNextButton, OnboardingShell } from '../onboarding-shell';

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
  onSessionStarted,
}: {
  agentConfigId: AgentConfigId;
  project: DesktopOnboardingProjectSelection;
  onBack: () => void;
  onAgentConfigChange: (config: AgentConfigMeta) => void;
  onSkip: () => void;
  onContinue: () => void;
  onSessionStarted: (input: { sessionId: string; workspaceSlug: string }) => void;
}) {
  const { t } = useTranslation();
  const user = useAtomValue(userAtom);
  const workspaceSlug = useAtomValue(currentWorkspaceSlugAtom);
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const resolvedWorkspaceSlug = workspaceSlug ?? runtime?.workspaceSlug ?? null;
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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canStartFirstTask =
    project.kind === 'local' &&
    config !== null &&
    config.machineId === project.machineId &&
    runtime !== null &&
    user !== null &&
    resolvedWorkspaceSlug !== null;
  const hasPrompt = prompt.trim().length > 0;
  const canCreateSession = canStartFirstTask && hasPrompt;
  const primaryAction = getFirstTaskPrimaryAction({
    canStartFirstTask,
    hasPrompt,
    submitting,
    startFailed: error !== null,
  });

  const handleSubmit = useCallback(() => {
    if (
      !canCreateSession ||
      submitting ||
      project.kind !== 'local' ||
      !config ||
      !user ||
      !resolvedWorkspaceSlug
    ) {
      return;
    }
    const trimmedPrompt = prompt.trim();
    setSubmitting(true);
    setError(null);
    void (async () => {
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
            machineId: project.machineId,
            agentConfigId: config.id,
            env: config.env,
            project: projectRef,
            title: trimmedPrompt.slice(0, 50),
            titleSource: 'draft',
          },
          entry
        );
        // The Session and its first turn are already durable. Dispatch is only
        // acceleration; normal recovery can pick up the pointer if this request
        // fails, so it must not turn a successful first Session into a failure.
        void requestSessionDispatch(result.sessionId, result.historyEntry.id, {
          inputConfig: result.historyEntry.inputConfig,
          machineId: project.machineId,
        }).catch((dispatchError: unknown) => {
          console.error('Failed to accelerate the first onboarding session', dispatchError);
        });
        onSessionStarted({ sessionId: result.sessionId, workspaceSlug: resolvedWorkspaceSlug });
      } catch (submitError) {
        console.error('Failed to start the first onboarding session', submitError);
        setError(
          t(
            'onboarding.firstTask.startFailed',
            'The session could not start. Enter Lody and finish setup from Settings.'
          )
        );
        setSubmitting(false);
      }
    })();
  }, [
    canCreateSession,
    config,
    onSessionStarted,
    project,
    prompt,
    requestSessionDispatch,
    resolvedWorkspaceSlug,
    startSession,
    submitting,
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
        conversationStatus: submitting ? 'starting' : prompt.trim() ? 'draft' : 'empty',
      }}
      secondaryAction={<OnboardingBackButton onClick={onBack} disabled={submitting} />}
      primaryAction={
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="lg"
            onClick={onSkip}
            disabled={submitting}
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
              setError(null);
              onAgentConfigChange(next);
            }}
            disabled={submitting || availableConfigs.length === 0}
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
          disabled={submitting}
          placeholder={t('onboarding.firstTask.promptPlaceholder', 'What should Lody do first?')}
        />
        <div className="flex flex-wrap gap-2">
          {seedPrompts.map((seed) => (
            <button
              key={seed}
              type="button"
              onClick={() => setPrompt(seed)}
              disabled={submitting}
              className={cn(
                'rounded-full border border-border px-3 py-1 text-xs text-muted-foreground',
                'hover:bg-muted hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring'
              )}
            >
              {seed}
            </button>
          ))}
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </div>
    </OnboardingShell>
  );
}

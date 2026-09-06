import { useCallback } from 'react';
import { useAtomValue } from 'jotai';
import { useRouter } from '@tanstack/react-router';
import { usePostHog } from '@posthog/react';
import {
  buildPendingUserHistoryEntry,
  buildSessionTurnInputConfig,
  getMissingTaskExecutionFields,
  getServerNow,
  hashAnalyticsId,
  type AgentConfigMeta,
  type ProjectRef,
  type SessionId,
  type TaskAgentRef,
  type TaskId,
} from '@lody/shared';
import { currentWorkspaceIdAtom, currentWorkspaceSlugAtom, userAtom } from '@/atoms';
import { getAllAgentConfigAtom } from '@/atoms/agents';
import { buildAgentPrompt } from '@/lib';
import { filterAcpSessionConfigOptionValuesForTarget } from '@/lib/acp-session-config-selection';
import { capturePostHogEvent } from '@/lib/posthog-analytics';
import {
  buildSessionCreateAcpAnalyticsProperties,
  SESSION_ACP_CONFIG_USED_EVENT,
} from '@/lib/session-create-analytics';
import { useSessionActions } from '@/hooks/use-session-actions';
import { useTaskActions } from '@/hooks/use-task-actions';
import { useVisibleMachineMetas } from '@/hooks/use-visible-machine-metas';

export type TaskRunRequest = {
  taskId: TaskId;
  title: string;
  body: string;
  agent: TaskAgentRef;
  projects: ProjectRef[];
};

export type TaskRunOutcome =
  | { ok: true; sessionId: SessionId }
  | { ok: false; reason: 'missing_fields' | 'agent_not_found' | 'not_ready' };

/**
 * Builds the brief the agent receives when a task is started.
 *
 * The rendered user message stays a one-liner while the prompt carries the full
 * body, so a session does not open with a wall of markdown but the agent still
 * gets the whole spec.
 */
export const buildTaskBrief = (title: string, body: string): string => {
  const trimmedBody = body.trim();
  const header = `You are executing a Lody task.\n\nTask: ${title}`;
  if (!trimmedBody) {
    return `${header}\n\n(The task has no description yet — ask for details if the title is not enough.)`;
  }
  return `${header}\n\n---\n\n${trimmedBody}`;
};

/**
 * Starts a task: creates a session, injects the brief, links it back with
 * `run` provenance, and moves the task to in progress.
 *
 * Status advances when the dispatch is accepted locally, not when the button is
 * clicked, and a later turn failure does not roll it back: "started and then
 * failed" is a true description of in-progress work.
 */
export function useTaskRun() {
  const router = useRouter();
  const postHog = usePostHog();
  const user = useAtomValue(userAtom);
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const workspaceSlug = useAtomValue(currentWorkspaceSlugAtom);
  const agentConfigs = useAtomValue(getAllAgentConfigAtom);
  const { startSession, requestSessionDispatch } = useSessionActions();
  const { linkSession, updateTaskFields } = useTaskActions();
  const { machines } = useVisibleMachineMetas({ includeMachineFlock: true });

  return useCallback(
    async (request: TaskRunRequest): Promise<TaskRunOutcome> => {
      const userId = user?.id;
      if (!userId) {
        return { ok: false, reason: 'not_ready' };
      }
      if (
        getMissingTaskExecutionFields({ agent: request.agent, projects: request.projects }).length >
        0
      ) {
        return { ok: false, reason: 'missing_fields' };
      }

      const config = (agentConfigs as AgentConfigMeta[]).find(
        (candidate) => candidate.id === request.agent.agentConfigId
      );
      if (!config) {
        return { ok: false, reason: 'agent_not_found' };
      }

      const project = request.projects[0];
      const brief = buildTaskBrief(request.title, request.body);
      const inputBlocks = [{ type: 'text' as const, text: `▶ ${request.title}` }];
      const configOptionValues = filterAcpSessionConfigOptionValuesForTarget({
        configId: config.id,
        cliType: config.cliType,
        agentType: config.agentType,
        runtimeOverrides: config.runtimeOverrides,
        machine: machines.get(config.machineId) ?? null,
        selectedModeId: request.agent.modeId,
        selectedModelId: request.agent.modelId,
        configOptionValues: request.agent.configOptionValues,
      });
      const inputConfig = buildSessionTurnInputConfig({
        inputBlocks,
        prompt: buildAgentPrompt(brief, config.prompt ?? ''),
        cliType: config.cliType,
        agentType: config.agentType,
        modeId: request.agent.modeId,
        modelId: request.agent.modelId,
        configOptionValues,
        taskToolsEnabled: true,
      });
      const pendingHistoryEntry = buildPendingUserHistoryEntry({
        userId,
        inputBlocks,
        timestamp: new Date(getServerNow()).toISOString(),
        inputConfig,
      });
      if (!pendingHistoryEntry) {
        return { ok: false, reason: 'not_ready' };
      }

      const { sessionId, historyEntry } = await startSession(
        {
          userId,
          cliType: config.cliType,
          agentType: config.agentType,
          customAcp: config.customAcp,
          runtimeOverrides: config.runtimeOverrides,
          machineId: config.machineId,
          agentConfigId: config.id,
          env: config.env,
          project,
          ...(project?.kind === 'github'
            ? { repoFullName: project.repoFullName, branchName: project.branch }
            : {}),
          ...(project?.kind === 'local' && project.branch ? { branchName: project.branch } : {}),
          title: request.title.slice(0, 50),
          titleSource: 'draft',
          taskId: request.taskId,
        },
        pendingHistoryEntry
      );

      // Task Run is a third session-creation surface alongside chat landing and
      // child tabs; it reports the same two events so sessions started from a
      // task are not invisible in session-creation analytics.
      const analyticsProperties = {
        user_id: userId,
        workspace_id: workspaceId,
        session_id: sessionId,
        machine_id: config.machineId,
        agent_config_id: config.id,
        cli_type: config.cliType,
        agent_type: config.agentType,
        ...buildSessionCreateAcpAnalyticsProperties({
          cliType: config.cliType,
          agentType: config.agentType,
          modeId: request.agent.modeId,
          modelId: request.agent.modelId,
          configOptionValues: request.agent.configOptionValues,
        }),
        project_kind: project?.kind ?? null,
        entrypoint: 'task_run',
      };
      capturePostHogEvent(postHog, 'session/start_requested', {
        ...analyticsProperties,
        repo_id_hash: hashAnalyticsId(
          project?.kind === 'github' ? project.repoFullName : undefined
        ),
        local_project_id: project?.kind === 'local' ? project.localProjectId : null,
        has_images: false,
        image_count: 0,
      });
      capturePostHogEvent(postHog, SESSION_ACP_CONFIG_USED_EVENT, analyticsProperties);

      // Dual-author (#3138): the renderer direct-authors its own durable writes,
      // so start never absorbs the dispatch and every creation surface requests
      // it unconditionally — same as chat landing and child tabs.
      await requestSessionDispatch(sessionId, historyEntry.id, {
        inputConfig,
        machineId: config.machineId,
      });

      // Sibling side effects of an accepted dispatch: neither may block the
      // navigation the user is waiting for.
      void linkSession(request.taskId, sessionId, 'run').catch((error: unknown) => {
        console.error('Failed to link task session', error);
      });
      void updateTaskFields(request.taskId, {
        status: 'in_progress',
        lastRunConfig: request.agent,
      }).catch((error: unknown) => {
        console.error('Failed to advance task status', error);
      });

      if (workspaceSlug) {
        void router.navigate({
          to: '/$workspaceName/sessions/$sessionId',
          params: { workspaceName: workspaceSlug, sessionId },
        });
      }

      return { ok: true, sessionId };
    },
    [
      agentConfigs,
      linkSession,
      machines,
      postHog,
      requestSessionDispatch,
      router,
      startSession,
      updateTaskFields,
      user?.id,
      workspaceId,
      workspaceSlug,
    ]
  );
}

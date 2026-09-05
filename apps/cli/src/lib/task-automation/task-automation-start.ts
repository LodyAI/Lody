import type { ProjectRef, TaskId, WorkspaceId } from '@lody/shared';
import type { AuthContext } from '@/lib/command-runtime';
import type { LoroDocumentManager } from '@/lib/loro/doc';
import type { WorkspaceSummary } from '@/lib/workspace';
import type { Logger } from '@/utils/logger';
import { applyAgentTaskUpdate, readTask } from '@/lib/task-doc';

export type TaskAutomationStartDeps = {
  auth: AuthContext;
  workspace: WorkspaceSummary;
  manager: LoroDocumentManager;
  logger: Logger;
  /**
   * Injected so this module does not import the command layer at load time —
   * `session.ts` already imports task-doc, and a static cycle here would break
   * the bundle.
   */
  createSession: (args: {
    auth: AuthContext;
    workspace: WorkspaceSummary;
    manager: LoroDocumentManager;
    prompt: string;
    options: Record<string, unknown>;
  }) => Promise<{ sessionId: string }>;
};

/**
 * The brief an auto-started session opens with.
 *
 * It asks the agent to close the loop on the task itself, because nobody is
 * watching this session: if the agent does not report back, the task looks
 * abandoned even though the work happened.
 */
export const buildAutomationBrief = (title: string, body: string): string => {
  const trimmed = body.trim();
  const header = `You are executing a Lody task that was delegated to you.\n\nTask: ${title}`;
  const closing =
    '\n\nWhen you finish, call lody_task_update to move the task to needs_review ' +
    '(and link the pull request if you opened one), and lody_task_comment to summarize what you did. ' +
    'Nobody is watching this session, so that report is how the work becomes visible.';
  if (!trimmed) {
    return `${header}\n\n(The task has no description. If the title is not enough to act on, say so in a task comment instead of guessing.)${closing}`;
  }
  return `${header}\n\n---\n\n${trimmed}${closing}`;
};

/** Maps the task's stored project onto session-create selectors. */
export const buildProjectOptions = (project: ProjectRef | undefined): Record<string, unknown> => {
  if (!project) {
    return {};
  }
  if (project.kind === 'github') {
    return {
      repo: project.repoFullName,
      ...(project.branch ? { branch: project.branch } : {}),
    };
  }
  return {
    localProject: project.localProjectId,
    ...(project.branch ? { branch: project.branch } : {}),
    ...(project.useWorktree ? { worktree: true } : {}),
  };
};

/**
 * Starts one delegated task: reads it, dispatches a session carrying the brief,
 * and moves the task to in progress.
 *
 * Status advances only after the dispatch is durable, and a later turn failure
 * does not roll it back — "started and then failed" is a true description of
 * in-progress work.
 */
export const startDelegatedTask = async (
  deps: TaskAutomationStartDeps,
  taskId: TaskId,
  agentConfigId: string
): Promise<void> => {
  const snapshot = await readTask(deps.manager, taskId);
  if (!snapshot) {
    throw new Error(`Task not found: ${taskId}`);
  }
  const projects = (snapshot.meta.projects ?? []) as ProjectRef[];
  const project = projects[0];
  if (!project) {
    throw new Error(`Task has no project: ${taskId}`);
  }

  const result = await deps.createSession({
    auth: deps.auth,
    workspace: deps.workspace,
    manager: deps.manager,
    prompt: buildAutomationBrief(snapshot.meta.title, snapshot.body),
    options: {
      agentConfig: agentConfigId,
      taskId,
      taskLinkOrigin: 'run',
      title: snapshot.meta.title.slice(0, 50),
      ...buildProjectOptions(project),
    },
  });

  deps.logger.debug(`[task-automation] started sessionId=${result.sessionId} for taskId=${taskId}`);

  await applyAgentTaskUpdate(
    deps.manager,
    deps.workspace.id as WorkspaceId,
    taskId,
    { status: 'in_progress' },
    { agentConfigId }
  );
};

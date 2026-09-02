import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CompositionEvent,
} from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { useParams, useRouter } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ArrowLeft, Plus } from 'lucide-react';
import {
  TASK_STATUS_VALUES,
  normalizeTaskLabels,
  type AgentConfigMeta,
  type ProjectRef,
  type SessionId,
  type SessionMeta,
  type TaskAgentRef,
  type TaskId,
  type TaskPriority,
  type TaskStatus,
  type WorkspaceId,
} from '@lody/shared';
import { authTokenAtom, currentWorkspaceIdAtom, currentWorkspaceSlugAtom } from '@/atoms';
import { TASK_DETAIL_ROUTE_ID } from './task-routes';
import { resolveTaskSessionActivity } from './task-session-activity';
import { getAllAgentConfigAtom } from '@/atoms/agents';
import { useIsMobile } from '@/hooks/use-mobile';
import { useOrganization } from '@/hooks/useOrganization';
import { useOnlineMachineIds } from '@/hooks/use-machine-online-status';
import { useTaskActions } from '@/hooks/use-task-actions';
import {
  findTaskAgentMentions,
  findTaskUserMentions,
  useTaskCommentDispatch,
} from '@/hooks/use-task-comment-dispatch';
import { useTaskDoc } from '@/hooks/use-task-doc';
import { useTaskRun } from '@/hooks/use-task-run';
import { useTaskSessionRollup } from '@/hooks/use-task-session-rollup';
import { selectAttachableSessions } from '@/lib/task-attachable-sessions';
import { allActiveSessionsAtom, archivedSessionListAtom } from '@/atoms/doc-meta';
import { taskListAtom, taskThreadReadAtAtom } from '@/atoms/tasks';
import { useVisibleLocalProjectsFromMachineIndex } from '@/hooks/use-visible-local-projects';
import { useVisibleMachineMetas } from '@/hooks/use-visible-machine-metas';
import { useCloudQuery } from '@lody/platform/react';
import { useOpenSettings } from '@/hooks/use-open-settings';
import { cloudOperations } from '@/lib/cloud-api-operations';
import type { UnifiedLocalProjectOption } from '@/components/chat/unified-project-selector';
import { getChatLandingProjectRecency } from '@/components/chat/chat-landing-derived';
import { Button } from '@lody/ui/button';
import { ScrollArea } from '@/ui/scroll-area';
import { TooltipProvider } from '@/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { BaseHeader } from '@/components/page-headers/base-header';
import { cn } from '@/lib/utils';
import { TASK_IMAGE_ACCEPT, uploadTaskImage } from '@/lib/task-image-upload';
import { TaskBodyEditor } from './task-body-editor';
import { TaskPropertiesPanel } from './task-properties-panel';
import { TaskAttachSessionDialog } from './task-attach-session-dialog';
import { TaskThread } from './task-thread';
import { getTaskStatusPresentation } from './task-status-presentation';
import { TASKS_SURFACE_CLASS, tasksMenuClassName, tasksMenuSurfaceStyle } from './tasks-surface';

export type TaskDetailViewProps = {
  /**
   * Desktop Tasks workspace already draws the tab bar for this task, so the
   * detail view drops its own page header. Status lives in the properties
   * rail (Linear issue layout). Mobile keeps the full-page header.
   */
  embedded?: boolean;
};

/**
 * "owner/repo#123" when the URL parses as a pull request, otherwise the raw URL.
 * A link that fails to parse still has to render — a task can carry a PR from a
 * provider this never anticipated.
 */
const prLinkLabel = (url: string | undefined): string => {
  if (!url) return '';
  const match = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  return match ? `${match[1]}/${match[2]}#${match[3]}` : url;
};

export function TaskDetailView({ embedded = false }: TaskDetailViewProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const isMobile = useIsMobile();
  const taskParams = useParams({ from: TASK_DETAIL_ROUTE_ID, shouldThrow: false });
  const taskId = (taskParams?.taskId ?? null) as TaskId | null;
  const workspaceSlug = useAtomValue(currentWorkspaceSlugAtom);
  const agentConfigs = useAtomValue(getAllAgentConfigAtom) as AgentConfigMeta[];
  const onlineMachineIds = useOnlineMachineIds();
  const visibleMachineIndex = useVisibleMachineMetas({ includeMachineFlock: true });
  const { machines } = visibleMachineIndex;
  const localProjects = useVisibleLocalProjectsFromMachineIndex(visibleMachineIndex);
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const authToken = useAtomValue(authTokenAtom);
  const githubRepositories = useCloudQuery(
    cloudOperations.github.getWorkspaceRepositories,
    workspaceId ? { workspaceId } : 'skip'
  ) as { repoFullName?: string; fullName?: string }[] | null | undefined;

  const { state, ready, sessionLinks, prLinks, timeline } = useTaskDoc(taskId);
  const { activeOrganization } = useOrganization();
  const rollup = useTaskSessionRollup(taskId);
  const { updateTaskFields, setTaskBody, appendComment, attachSession, detachSession } =
    useTaskActions();
  const runTask = useTaskRun();
  const dispatchComment = useTaskCommentDispatch();

  const [pendingQuote, setPendingQuote] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const allSessions = useAtomValue(allActiveSessionsAtom);
  const archivedSessions = useAtomValue(archivedSessionListAtom);
  const allTasks = useAtomValue(taskListAtom);
  const setThreadReadAt = useSetAtom(taskThreadReadAtAtom);

  // Every conversation this client knows about, archived included: a task
  // outlives the sessions it spawned, and an archived one still deserves its
  // title. Active entries win on collision.
  const sessionById = useMemo(() => {
    const map = new Map<string, SessionMeta>();
    for (const session of archivedSessions) map.set(session.id, session);
    for (const session of allSessions) {
      if (session.id) map.set(session.id, session);
    }
    return map;
  }, [allSessions, archivedSessions]);
  const projectRecency = useMemo(
    () => getChatLandingProjectRecency(sessionById.values()),
    [sessionById]
  );

  const handleImageUpload = useCallback(
    async (file: File): Promise<string | undefined> => {
      if (!workspaceId || !authToken) {
        throw new Error(t('tasks.images.unavailable', 'Image upload is unavailable.'));
      }
      const result = await uploadTaskImage({
        workspaceId: workspaceId as WorkspaceId,
        token: authToken,
        file,
      });
      return result.markdownUrl;
    },
    [authToken, t, workspaceId]
  );

  const meta = state.meta as unknown as {
    title: string;
    status: TaskStatus;
    ownerId: string;
    priority?: TaskPriority;
    labels?: string[];
    agent?: TaskAgentRef;
    lastRunConfig?: TaskAgentRef;
    projects?: ProjectRef[];
  };
  const body = (state.body ?? '') as unknown as string;

  const agentOptions = useMemo(
    () =>
      agentConfigs.map((config) => ({
        agentConfigId: config.id as string,
        name: config.name || `${config.cliType}`,
        homeName:
          machines.get(config.machineId)?.name ??
          t('tasks.slots.unknownMachine', 'Unknown machine'),
        presence: onlineMachineIds.has(config.machineId)
          ? ('online' as const)
          : ('offline' as const),
      })),
    [agentConfigs, machines, onlineMachineIds, t]
  );

  // Picking an agent in the Run panel and entrusting the task to one are two
  // different acts. `agent` means "this task is delegated" and is what makes the
  // CLI scheduler start it unattended, so the panel must not write it — otherwise
  // choosing who to run once silently enrolls the task in automation, and the
  // scheduler can fire before the person even clicks Run. The panel writes
  // `lastRunConfig`, which is also what makes it prefill next time; an entrusted
  // task falls back to its entrusted agent.
  // Order per specs/tasks.md: the entrusted agent wins over "who I ran it with
  // last time". Reversing these let a task delegated to X but run once with Y
  // show Y in the picker while the checkbox said X would pick it up. A sole
  // online agent is the last resort so a fresh task is one click from running.
  const soleOnlineAgent = useMemo(() => {
    const online = agentOptions.filter((option) => option.presence === 'online');
    return online.length === 1 ? online[0] : undefined;
  }, [agentOptions]);

  // Memoised because the sole-online-agent branch builds a fresh object, which
  // would otherwise change identity every render and defeat the callbacks below.
  const runAgent = useMemo<TaskAgentRef | undefined>(() => {
    if (meta.agent) return meta.agent;
    if (meta.lastRunConfig) return meta.lastRunConfig;
    if (soleOnlineAgent) {
      return { agentConfigId: soleOnlineAgent.agentConfigId as TaskAgentRef['agentConfigId'] };
    }
    return undefined;
  }, [meta.agent, meta.lastRunConfig, soleOnlineAgent]);

  const selectedAgentConfig = useMemo(
    () => agentConfigs.find((config) => config.id === runAgent?.agentConfigId) ?? null,
    [agentConfigs, runAgent?.agentConfigId]
  );

  const selectedAgent = useMemo(
    () => agentOptions.find((option) => option.agentConfigId === runAgent?.agentConfigId) ?? null,
    [agentOptions, runAgent?.agentConfigId]
  );

  // Same option shape as chat landing. When an agent is picked, local projects
  // are scoped to its machine (a local project lives on one computer); with no
  // agent yet, every machine's projects stay visible so capture still works.
  const unifiedLocalProjects = useMemo<UnifiedLocalProjectOption[]>(() => {
    const agentMachineId = selectedAgentConfig?.machineId;
    const entries = [...localProjects.projects.values()].filter((entry) =>
      agentMachineId ? entry.machineId === agentMachineId : true
    );
    return entries.map((entry) => ({
      key: entry.key,
      machineId: entry.machineId,
      localProjectId: entry.project.id,
      name: entry.project.name,
      // Multi-machine lists need the host in the secondary line; single-machine
      // lists keep the path, matching the landing picker.
      rootPath: agentMachineId
        ? entry.project.rootPath
        : `${entry.machine.name} · ${entry.project.rootPath}`,
      lastUsedAt:
        projectRecency.byProject.get(entry.key) ??
        entry.project.lastOpenedAtMs ??
        entry.project.createdAtMs,
    }));
  }, [localProjects.projects, projectRecency.byProject, selectedAgentConfig?.machineId]);

  const repositories = useMemo(
    () =>
      (githubRepositories ?? []).flatMap((repository) => {
        const fullName = repository.repoFullName ?? repository.fullName;
        return fullName ? [{ fullName }] : [];
      }),
    [githubRepositories]
  );

  const selectedProjectRef = meta.projects?.[0] ?? null;
  const { openSettings } = useOpenSettings();

  const handleSelectRunAgent = useCallback(
    (next: TaskAgentRef) => {
      if (!taskId) {
        return;
      }
      // Run panel / properties picker only touch lastRunConfig — never the
      // delegated `agent` field (that is the separate hand-over checkbox).
      void updateTaskFields(taskId, { lastRunConfig: next });
    },
    [taskId, updateTaskFields]
  );

  const handleSelectProject = useCallback(
    (project: ProjectRef | null) => {
      if (!taskId) {
        return;
      }
      void updateTaskFields(taskId, { projects: project ? [project] : [] });
    },
    [taskId, updateTaskFields]
  );

  const canRun = Boolean(runAgent?.agentConfigId) && Boolean(selectedProjectRef);

  const handleRun = useCallback(() => {
    if (!taskId || !runAgent || !selectedProjectRef) {
      toast.error(t('tasks.run.missingFields', 'Pick an agent and a project to run this task.'));
      return;
    }
    void (async () => {
      setRunning(true);
      try {
        const outcome = await runTask({
          taskId,
          title: meta.title,
          body,
          agent: runAgent as never,
          projects: [selectedProjectRef],
        });
        if (!outcome.ok) {
          toast.error(t('tasks.run.failed', 'Could not start this task.'));
        }
      } catch (error: unknown) {
        toast.error(error instanceof Error ? error.message : String(error));
      } finally {
        setRunning(false);
      }
    })();
  }, [body, meta.title, runAgent, runTask, selectedProjectRef, t, taskId]);

  const attachableSessions = useMemo(() => {
    if (!taskId) {
      return [];
    }
    const titles = new Map(allTasks.map((entry) => [entry.taskId, entry.title]));
    return selectAttachableSessions(allSessions, taskId, titles);
  }, [allSessions, allTasks, taskId]);

  const newestCommentAt = useMemo(
    () =>
      timeline.reduce(
        (latest, entry) =>
          entry.kind === 'comment' && entry.createdAt > latest ? entry.createdAt : latest,
        0
      ),
    [timeline]
  );

  // Opening the task is what marks its thread read, and it marks against the
  // newest comment AT THAT MOMENT — not "now", and not the newest comment as it
  // keeps arriving. Re-running on every new comment would mark mentions read
  // while the page merely sits in a background tab, which is the case this whole
  // scheme exists to avoid. `markedTaskIdRef` keeps it to once per opened task.
  const markedTaskIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!taskId || !ready || newestCommentAt === 0) {
      return;
    }
    if (markedTaskIdRef.current === taskId) {
      return;
    }
    markedTaskIdRef.current = taskId;
    setThreadReadAt((previous) =>
      (previous[taskId] ?? 0) >= newestCommentAt
        ? previous
        : { ...previous, [taskId]: newestCommentAt }
    );
  }, [newestCommentAt, ready, setThreadReadAt, taskId]);

  const openSession = useCallback(
    (sessionId: string) => {
      if (!workspaceSlug) {
        return;
      }
      void router.navigate({
        to: '/$workspaceName/sessions/$sessionId',
        params: { workspaceName: workspaceSlug, sessionId: sessionId as SessionId },
      });
    },
    [router, workspaceSlug]
  );

  // Title edits are local-first while typing, for the same reason the body
  // editor is: the doc write is async, so a fully controlled input would round
  // trip every keystroke through the task doc. With an IME that round trip
  // lands mid-composition and wipes the preedit buffer — CJK input becomes
  // impossible to type. We hold a draft, never write during composition, and
  // drop back to the remote value once it catches up (or on blur).
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const titleComposingRef = useRef(false);

  useEffect(() => {
    setTitleDraft(null);
    titleComposingRef.current = false;
  }, [taskId]);

  useEffect(() => {
    if (titleDraft === null) return;
    if (titleDraft === meta.title) {
      setTitleDraft(null);
    }
  }, [meta.title, titleDraft]);

  const commitTitle = useCallback(
    (next: string) => {
      if (!taskId) return;
      void updateTaskFields(taskId, { title: next });
    },
    [taskId, updateTaskFields]
  );

  const handleTitleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const next = event.target.value;
      setTitleDraft(next);
      if (titleComposingRef.current) return;
      commitTitle(next);
    },
    [commitTitle]
  );

  const handleTitleCompositionStart = useCallback(() => {
    titleComposingRef.current = true;
  }, []);

  const handleTitleCompositionEnd = useCallback(
    (event: CompositionEvent<HTMLInputElement>) => {
      titleComposingRef.current = false;
      // Chrome fires compositionend after the final change, Safari before it;
      // committing here covers the browsers where no change event follows.
      const next = event.currentTarget.value;
      setTitleDraft(next);
      commitTitle(next);
    },
    [commitTitle]
  );

  const handleTitleBlur = useCallback(() => {
    titleComposingRef.current = false;
    setTitleDraft(null);
  }, []);

  const handleStatusChange = useCallback(
    (status: TaskStatus) => {
      if (!taskId) return;
      void updateTaskFields(taskId, { status });
    },
    [taskId, updateTaskFields]
  );

  const handleToggleDelegation = useCallback(() => {
    if (!taskId) return;
    // The one place `agent` is written: an explicit hand-over, never a side
    // effect of choosing who runs it once. When turning on, snapshot the full
    // run config so delegated automation uses the same model/mode/options.
    void updateTaskFields(taskId, {
      agent: meta.agent?.agentConfigId ? null : (runAgent ?? null),
    });
  }, [meta.agent?.agentConfigId, runAgent, taskId, updateTaskFields]);

  const delegatedTo = meta.agent?.agentConfigId
    ? (agentOptions.find((option) => option.agentConfigId === meta.agent?.agentConfigId)?.name ??
      t('tasks.slots.thisAgent', 'this agent'))
    : null;

  const handlePriorityChange = useCallback(
    (priority: TaskPriority | null) => {
      if (!taskId) return;
      void updateTaskFields(taskId, { priority });
    },
    [taskId, updateTaskFields]
  );

  const handleOwnerChange = useCallback(
    (nextOwnerId: string | null) => {
      if (!taskId) return;
      void updateTaskFields(taskId, { ownerId: nextOwnerId });
    },
    [taskId, updateTaskFields]
  );

  const handleLabelsChange = useCallback(
    (labels: string[]) => {
      if (!taskId) return;
      void updateTaskFields(taskId, { labels: normalizeTaskLabels(labels) });
    },
    [taskId, updateTaskFields]
  );

  const handleCommentSubmit = useCallback(
    (input: { body: string; quote?: string }) => {
      if (!taskId) return;
      void (async () => {
        const mentions = findTaskAgentMentions(
          input.body,
          agentConfigs.map((config) => ({
            id: config.id as string,
            name: config.name,
          }))
        );
        // A plain comment is only a record. Mentioning an agent is the
        // explicit act that turns it into work, and the work happens in
        // a session, not here.
        const dispatched =
          mentions.agentConfigIds.length > 0
            ? await dispatchComment({
                taskId,
                taskTitle: meta.title,
                comment: input.body,
                ...(input.quote ? { quote: input.quote } : {}),
                sessions: rollup.sessions,
              })
            : null;
        // People reachable by @ here are this task's participants; the
        // recorded actor names are the only member names available.
        const participants = new Map<string, string>();
        for (const entry of timeline) {
          if (entry.actorKind === 'human' && entry.actorId && entry.actorName) {
            participants.set(entry.actorId, entry.actorName);
          }
        }
        const userMentions = findTaskUserMentions(
          input.body,
          [...participants].map(([id, name]) => ({ id, name }))
        );
        await appendComment(taskId, {
          body: input.body,
          ...(input.quote ? { quote: input.quote } : {}),
          ...(userMentions.length > 0 ? { mentions: userMentions } : {}),
          ...(mentions.agentConfigIds.length > 0 ? { agentMentions: mentions.agentConfigIds } : {}),
          ...(dispatched?.ok ? { dispatchedSessionId: dispatched.sessionId } : {}),
        });
        if (dispatched && !dispatched.ok && dispatched.reason === 'no_session') {
          toast.info(
            t(
              'tasks.thread.noSessionForMention',
              "That agent isn't working on this task yet — press Run to start it."
            )
          );
        }
      })();
    },
    [agentConfigs, appendComment, dispatchComment, meta.title, rollup.sessions, t, taskId, timeline]
  );

  // Bail out AFTER every hook has run. An early return above them makes the
  // hook count depend on `taskId`, so a mounted detail view whose route param
  // goes away renders fewer hooks than the previous render and React throws.
  if (!taskId) {
    return null;
  }

  // Owner spans every workspace member, not just this task's participants:
  // ownership is an assignment, so you must be able to hand a task to someone
  // who has not touched it yet. `activeOrganization.members` is already loaded
  // for the sidebar and chat surfaces, so this adds no query.
  const ownerOptions = (activeOrganization?.members ?? []).map((member) => ({
    userId: member.userId,
    name: member.user?.name ?? member.user?.email ?? member.userId,
    image: member.user?.image ?? null,
  }));

  const prRows = prLinks.map((link) => ({
    id: link.id,
    url: link.url ?? '',
    label: prLinkLabel(link.url),
  }));

  const presentation = getTaskStatusPresentation(meta.status);

  // Desktop (including embedded under the tab bar) uses Linear's two-column
  // issue layout. Mobile stacks: title → body → properties → sessions → thread.
  const showPageHeader = !embedded || isMobile;
  const useTwoColumn = !isMobile;

  const properties = (
    <TaskPropertiesPanel
      status={meta.status}
      onStatusChange={handleStatusChange}
      ownerId={meta.ownerId}
      members={ownerOptions}
      onOwnerChange={handleOwnerChange}
      priority={meta.priority ?? null}
      onPriorityChange={handlePriorityChange}
      labels={meta.labels ?? []}
      onLabelsChange={handleLabelsChange}
      prLinks={prRows}
      onOpenPr={(url) => window.open(url, '_blank', 'noopener,noreferrer')}
      agent={selectedAgent}
      runAgent={runAgent ?? null}
      onSelectRunAgent={handleSelectRunAgent}
      project={selectedProjectRef}
      onSelectProject={handleSelectProject}
      localProjects={unifiedLocalProjects}
      repositories={repositories}
      latestMessageAtByRepo={projectRecency.byRepo}
      onAddLocalProject={() => openSettings('projects')}
      onConnectGitRepo={() => openSettings('github')}
      canRun={canRun}
      running={running}
      hasActiveSession={rollup.running}
      onRun={handleRun}
      delegatedTo={delegatedTo}
      onToggleDelegation={handleToggleDelegation}
      disabled={!ready}
    />
  );

  // Linked conversations feed the timeline instead of owning a section of
  // their own. Provenance is localized here (the thread is a pure view) and
  // titles resolve from session meta, falling back rather than showing an id.
  const sessionEvents = sessionLinks.map((link) => {
    // Not `rollup.sessions`: that set only holds sessions whose own meta points
    // back at this task, so a link made from the task side (attach, propose)
    // resolved to nothing and the row read "Session" with no status at all.
    // Archived conversations stay resolvable for the same reason.
    const session = sessionById.get(link.sessionId as string);
    const parentTitle = link.parentSessionId
      ? allSessions.find((item) => item.id === link.parentSessionId)?.title
      : undefined;
    const provenance =
      link.origin === 'run'
        ? t('tasks.provenance.run', 'started from this task')
        : link.origin === 'agent-spawn'
          ? parentTitle
            ? t('tasks.provenance.spawnedBy', 'spawned by \u201c{{parent}}\u201d', {
                parent: parentTitle,
              })
            : t('tasks.provenance.spawn', 'spawned by an agent')
          : link.origin === 'propose-source'
            ? t('tasks.provenance.propose', 'proposed this task')
            : t('tasks.provenance.manual', 'linked manually');
    return {
      linkId: link.id,
      sessionId: link.sessionId as string,
      title: session?.title ?? t('tasks.sessionUntitled', 'Session'),
      provenance,
      activity: resolveTaskSessionActivity(session),
      linkedAt: link.linkedAt,
      ...(link.actorName ? { actorName: link.actorName } : {}),
      ...(link.actorKind ? { actorKind: link.actorKind } : {}),
    };
  });

  const mainColumn = (
    <div
      className={cn(
        'mx-auto flex w-full flex-col',
        useTwoColumn ? 'max-w-3xl gap-8 px-8 py-8' : 'max-w-3xl gap-6 px-4 py-5'
      )}
    >
      {/* Title: plain text, no input chrome — the grey Input bar was the
         loudest thing on the page and fought Linear's clean heading. */}
      <input
        value={titleDraft ?? meta.title}
        disabled={!ready}
        placeholder={t('tasks.titlePlaceholder', 'Task title')}
        onChange={handleTitleChange}
        onCompositionStart={handleTitleCompositionStart}
        onCompositionEnd={handleTitleCompositionEnd}
        onBlur={handleTitleBlur}
        className={cn(
          'w-full bg-transparent text-foreground outline-none placeholder:text-muted-foreground/50',
          'border-0 p-0 shadow-none focus-visible:ring-0',
          useTwoColumn
            ? 'text-[1.65rem] font-semibold leading-tight tracking-tight'
            : 'text-xl font-semibold leading-tight'
        )}
      />

      <TaskBodyEditor
        key={taskId}
        value={body}
        disabled={!ready}
        onCommit={(next) => setTaskBody(taskId, next)}
        onQuoteSelection={setPendingQuote}
        onImagePaste={handleImageUpload}
        imageAccept={TASK_IMAGE_ACCEPT}
      />

      {/* Mobile stacks properties under the body (no right rail). Desktop
         keeps them in the aside so the main column stays title → body → … */}
      {!useTwoColumn ? <div className="border-t border-border/50 pt-6">{properties}</div> : null}

      <div className="border-t border-border/50 pt-6">
        <TaskThread
          entries={timeline}
          sessionEvents={sessionEvents}
          headerAction={
            <button
              type="button"
              onClick={() => setAttachOpen(true)}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted-foreground/[0.08] hover:text-foreground"
            >
              <Plus className="h-3.5 w-3.5" />
              {t('tasks.attach.action', 'Attach')}
            </button>
          }
          disabled={!ready}
          pendingQuote={pendingQuote}
          onClearQuote={() => setPendingQuote(null)}
          onSubmit={handleCommentSubmit}
          onImagePaste={handleImageUpload}
          imageAccept={TASK_IMAGE_ACCEPT}
          onOpenSession={openSession}
          onDetachSession={(sessionId) => {
            void detachSession(taskId, sessionId as SessionId).catch(() => {
              toast.error(
                t('tasks.links.updateFailed', 'Could not update the task links. Please try again.')
              );
            });
          }}
        />
      </div>

      <TaskAttachSessionDialog
        open={attachOpen}
        sessions={attachableSessions}
        onAttach={(sessionId) => {
          setAttachOpen(false);
          void attachSession(taskId, sessionId as SessionId).catch(() => {
            toast.error(
              t('tasks.links.updateFailed', 'Could not update the task links. Please try again.')
            );
          });
        }}
        onClose={() => setAttachOpen(false)}
      />
    </div>
  );

  const mobileStatusMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" size="small">
          <presentation.Icon className={`h-3.5 w-3.5 ${presentation.className}`} />
          {t(presentation.labelKey, presentation.labelFallback)}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className={tasksMenuClassName()}
        style={tasksMenuSurfaceStyle}
      >
        {TASK_STATUS_VALUES.map((status) => {
          const option = getTaskStatusPresentation(status);
          return (
            <DropdownMenuItem key={status} onClick={() => handleStatusChange(status)}>
              <option.Icon className={`h-3.5 w-3.5 ${option.className}`} />
              {t(option.labelKey, option.labelFallback)}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <TooltipProvider>
      {/* `w-full flex-1` for the same reason as the list page: the desktop
         layout's flex ROW would otherwise leave this page at max-content width. */}
      <div
        className={cn(
          // When embedded under TasksWorkspace the parent already carries
          // tasks-surface; re-applying is harmless and covers standalone /
          // mobile routes that mount this view alone.
          TASKS_SURFACE_CLASS,
          'flex h-full w-full flex-1 flex-col overflow-hidden bg-background'
        )}
      >
        {showPageHeader ? (
          <BaseHeader
            title={meta.title || t('tasks.untitled', 'Untitled task')}
            leading={
              isMobile ? null : (
                <Button
                  variant="ghost"
                  aria-label={t('common.back', 'Back')}
                  icon
                  onClick={() => {
                    if (workspaceSlug) {
                      void router.navigate({
                        to: '/$workspaceName/tasks',
                        params: { workspaceName: workspaceSlug },
                      });
                    }
                  }}
                >
                  <ArrowLeft className="h-4 w-4" />
                </Button>
              )
            }
            actions={isMobile ? mobileStatusMenu : null}
          />
        ) : null}

        {useTwoColumn ? (
          <div className="flex min-h-0 flex-1">
            <ScrollArea className="min-h-0 min-w-0 flex-1">{mainColumn}</ScrollArea>
            {/* Right rail: fixed width, independent scroll — matches Linear's
               properties column so long Activity timelines don't push Run off. */}
            <aside className="flex w-[16.5rem] shrink-0 flex-col overflow-y-auto border-l border-border/50 bg-card/40 px-2.5 py-7">
              {properties}
            </aside>
          </div>
        ) : (
          <ScrollArea className="min-h-0 flex-1">{mainColumn}</ScrollArea>
        )}
      </div>
    </TooltipProvider>
  );
}

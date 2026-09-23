import type { AgentRunRef } from '@/components/shared/agent-run-ref';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/ui/dialog';
import { useIsMobile } from '@/hooks/use-mobile';
import { useCommand } from '@/lib/commands';
import { useEffect, useMemo, useState } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { v4 as uuid } from 'uuid';
import { AlertTriangle, ArrowLeft, Pause, Play, Trash2, X, Zap } from 'lucide-react';
import { useCloudQuery } from '@lody/platform/react';
import {
  DEFAULT_SCHEDULE_DESTINATION,
  getServerNow,
  machineSupportsSchedulesProtocol,
  scheduleOwnSessionId,
  ScheduleRepository,
  type SessionId,
  type SessionMeta,
  type AgentConfigId,
  type AgentConfigMeta,
  type ProjectRef,
  type ScheduleDestination,
  type ScheduleDocument,
  type ScheduleRegistryRow,
} from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import {
  currentWorkspaceSlugAtom,
  sessionListAtom,
  archivedSessionListAtom,
  userAtom,
} from '@/atoms';
import { getAllAgentConfigAtom } from '@/atoms/agents';
import { schedulesFeatureEnabledAtom } from '@/atoms/settings';
import { openScheduleTabsAtom } from '@/atoms/schedules';
import { useResolvedWorkspaceScope } from '@/hooks/use-resolved-workspace-scope';
import {
  onlineMachineIdsAtom,
  lodyPresenceSyncStateAtom,
  sessionLiveStatusAtomFamily,
} from '@/atoms/presence';
import { useScheduleDocument, useSchedules } from '@/hooks/use-schedules';
import { useVisibleMachineMetas } from '@/hooks/use-visible-machine-metas';
import { useVisibleLocalProjects } from '@/hooks/use-visible-local-projects';
import { useOpenSettings } from '@/hooks/use-open-settings';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { AgentRunConfigMenu } from '@/components/shared/agent-run-config-menu';
import { ProjectRefSelector } from '@/components/shared/project-ref-selector';
import { Button } from '@/ui/button';
import { cn } from '@/lib/utils';
import { Switch } from '@/ui/switch';
import {
  ScheduleForm,
  ScheduleListView,
  matchingScheduleRuntime,
  newScheduleFormValue,
  type ScheduleFormValue,
} from './schedule-view';
import { PropertyRow, PropertyRowWide, scheduleCardClass } from './schedule-property-row';
import { collectScheduleSaveBlockers } from './schedule-save-blockers';
import { ScheduleDestinationRows, type PickableSession } from './schedule-destination-rows';

export function SchedulesWorkspace({ scheduleId }: { scheduleId?: string }) {
  const enabled = useAtomValue(schedulesFeatureEnabledAtom);
  return enabled ? <SchedulesContent scheduleId={scheduleId} /> : null;
}

function SchedulesContent({ scheduleId }: { scheduleId?: string }) {
  const { t } = useTranslation();
  const activeRuntime = useAtomValue(activeWorkspaceRuntimeAtom);
  const scope = useResolvedWorkspaceScope();
  const runtime =
    scope.enabled && scope.workspaceId === activeRuntime?.workspaceId ? activeRuntime : null;
  const user = useAtomValue(userAtom);
  const slug = useAtomValue(currentWorkspaceSlugAtom);
  const navigate = useNavigate();
  const registry = useSchedules();
  const agents = useAtomValue(getAllAgentConfigAtom);
  const localProjects = useVisibleLocalProjects({ includeMachineFlock: true });
  const onlineMachines = useAtomValue(onlineMachineIdsAtom);
  const presenceSync = useAtomValue(lodyPresenceSyncStateAtom);
  const openSession = (id: string) => {
    if (slug)
      void navigate({
        to: '/$workspaceName/sessions/$sessionId',
        params: { workspaceName: slug, sessionId: id as SessionId },
      });
  };
  const mobile = useIsMobile();
  const detail = useScheduleDocument(scheduleId);
  const [tabs, setTabs] = useAtom(openScheduleTabsAtom);
  const [error, setError] = useState<string>();
  const [confirmation, setConfirmation] = useState<{
    title: string;
    description: string;
    accept: () => Promise<void>;
  }>();
  const { machines } = useVisibleMachineMetas({ includeMachineFlock: true });
  const repository = useMemo(
    () => (runtime ? new ScheduleRepository(runtime.repo, runtime.workspaceId) : null),
    [runtime]
  );
  const open = (id?: string) => {
    if (slug)
      void navigate(
        id
          ? {
              to: '/$workspaceName/schedules/$scheduleId',
              params: { workspaceName: slug, scheduleId: id },
            }
          : { to: '/$workspaceName/schedules', params: { workspaceName: slug } }
      );
  };
  useEffect(() => {
    if (scheduleId)
      setTabs((previous) => (previous.includes(scheduleId) ? previous : [...previous, scheduleId]));
  }, [scheduleId, setTabs]);
  const mutate = async (action: () => Promise<void>) => {
    try {
      setError(undefined);
      await action();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t('schedules.saveError', 'The schedule could not be saved.')
      );
    }
  };
  const toggle = (row: ScheduleRegistryRow) => {
    const apply = async () => {
      if (!repository || !user) return;
      if (!row.enabled && !machineSupportsSchedulesProtocol(machines.get(row.machineId as never)))
        throw new Error(
          t('schedules.upgrade', 'Update the target machine’s CLI to edit schedules.')
        );
      await runtime!.withScheduleStore(row.scheduleId, () =>
        repository.setEnabled({
          scheduleId: row.scheduleId,
          enabled: !row.enabled,
          actorId: user.id,
          now: getServerNow(),
          activationId: uuid(),
          requestId: uuid(),
        })
      );
    };
    // Resuming does not re-ask about the permission mode. The mode is chosen and
    // shown in the editor; a second dialog here only trained people to confirm
    // without reading. Ownership and machine capability are still enforced above.
    void mutate(apply);
  };
  const row = registry.rows.find((r) => r.scheduleId === scheduleId);
  const isOwner = !!row && row.ownerId === user?.id;
  const canManage =
    isOwner && machineSupportsSchedulesProtocol(machines.get(row.machineId as never));
  useCommand({
    id: 'schedules.pause',
    title: t('commands.schedules.pause', 'Pause Schedule'),
    category: 'Workspace',
    keybindings: [],
    when: () => isOwner && row?.enabled === true,
    run: () => {
      if (row) toggle(row);
    },
  });
  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-settings-surface="">
      {mobile ? (
        scheduleId ? (
          <Button className="self-start m-2" variant="ghost" onClick={() => open()}>
            <ArrowLeft className="size-4" />
            {t('schedules.all', 'All schedules')}
          </Button>
        ) : null
      ) : (
        <nav
          className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b-[0.5px] border-border px-2 py-1.5"
          aria-label={t('schedules.tabs', 'Schedule tabs')}
        >
          <Button
            size="sm"
            className="h-7 shrink-0 px-2 text-[0.9em] font-normal"
            variant={!scheduleId ? 'secondary' : 'ghost'}
            onClick={() => open()}
          >
            {t('schedules.all', 'All schedules')}
          </Button>
          {tabs.map((id) => (
            <div
              key={id}
              className={cn(
                'flex shrink-0 items-center rounded-md pr-0.5',
                scheduleId === id && 'bg-secondary'
              )}
            >
              <Button
                size="sm"
                variant="ghost"
                className="h-7 max-w-40 px-2 text-[0.9em] font-normal hover:bg-transparent"
                onClick={() => open(id)}
              >
                <span className="truncate">
                  {id === 'new'
                    ? t('schedules.new', 'New schedule')
                    : (registry.rows.find((r) => r.scheduleId === id)?.title ??
                      t('schedules.title', 'Schedules'))}
                </span>
              </Button>
              <button
                type="button"
                className="rounded p-1 text-muted-foreground hover:bg-hover hover:text-foreground"
                aria-label={t('schedules.closeTab', 'Close tab')}
                onClick={() => {
                  setTabs(tabs.filter((item) => item !== id));
                  if (scheduleId === id) open();
                }}
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </nav>
      )}
      <Dialog
        open={!!confirmation}
        onOpenChange={(isOpen) => {
          if (!isOpen) setConfirmation(undefined);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirmation?.title}</DialogTitle>
            <DialogDescription>{confirmation?.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmation(undefined)}>
              {t('schedules.cancel', 'Cancel')}
            </Button>
            <Button
              onClick={() => {
                const action = confirmation?.accept;
                setConfirmation(undefined);
                if (action) void mutate(action);
              }}
            >
              {t('schedules.confirm', 'Confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {error ? (
        <p className="px-5 py-2 text-[1em] text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {!scheduleId ? (
        <ScheduleListView
          {...registry}
          onOpen={open}
          onNew={() => open('new')}
          onToggle={toggle}
          onOpenSession={openSession}
          contextForRow={(item) => ({
            machine: machines.get(item.machineId as never)?.name ?? item.machineId,
            agent: agents.find((a) => a.id === item.agentConfigId)?.name ?? item.agentConfigId,
            project: !item.projectKey
              ? null
              : item.projectKind === 'local'
                ? ([...localProjects.projects.values()].find(
                    (entry) =>
                      entry.machineId === item.machineId && entry.project.id === item.projectKey
                  )?.project.name ?? item.projectKey)
                : item.projectKey,
            presence: onlineMachines.has(item.machineId as never)
              ? 'online'
              : presenceSync === 'synced'
                ? 'offline'
                : 'unknown',
            canToggle:
              item.ownerId === user?.id &&
              (item.enabled ||
                machineSupportsSchedulesProtocol(machines.get(item.machineId as never))),
          })}
        />
      ) : scheduleId === 'new' ? (
        <div className="overflow-auto">
          <ScheduleEditor
            key={`${runtime?.workspaceId}:new`}
            onSaved={open}
            onOpenSession={openSession}
          />
        </div>
      ) : !detail.ready ? (
        <p className="p-5">{t('schedules.loading', 'Loading schedules…')}</p>
      ) : !detail.document || !row ? (
        <p className="p-5">{t('schedules.notFound', 'This schedule is unavailable or deleted.')}</p>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="sticky top-0 z-10 flex flex-wrap items-center gap-1.5 border-b-[0.5px] border-border bg-background/95 px-4 py-2 backdrop-blur">
            {row.enabled ? (
              <span className="mr-auto text-[0.9em] text-muted-foreground">
                {t(
                  'schedules.pauseHelp',
                  'Pausing stops future runs. Cancel already submitted Sessions separately.'
                )}
              </span>
            ) : (
              <span className="mr-auto rounded-full border-[0.5px] px-2 py-px text-[0.75em] font-normal text-muted-foreground">
                {t('schedules.paused', 'Paused')}
              </span>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[0.9em]"
              disabled={row.enabled ? !isOwner : !canManage}
              onClick={() => toggle(row)}
            >
              {row.enabled ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
              {row.enabled ? t('schedules.pause', 'Pause') : t('schedules.resume', 'Resume')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[0.9em]"
              disabled={!canManage}
              onClick={() =>
                setConfirmation({
                  title: t('schedules.runNow', 'Run now'),
                  description: t(
                    'schedules.runNowHelp',
                    'Run with the last saved prompt, Agent, Project and permission mode. Unsaved edits are excluded. This may run alongside existing work.'
                  ),
                  accept: async () => {
                    if (repository && user)
                      await runtime!.withScheduleStore(scheduleId, () =>
                        repository.requestRun({
                          scheduleId,
                          actorId: user.id,
                          manualRunId: uuid(),
                          now: getServerNow(),
                        })
                      );
                  },
                })
              }
            >
              <Zap className="size-3.5" />
              {t('schedules.runNow', 'Run now')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[0.9em] text-muted-foreground hover:text-destructive"
              disabled={!isOwner}
              onClick={() =>
                void mutate(async () => {
                  if (repository && user) {
                    await runtime!.withScheduleStore(scheduleId, () =>
                      repository.delete(scheduleId, user.id, getServerNow())
                    );
                    open();
                  }
                })
              }
            >
              <Trash2 className="size-3.5" />
              <span className="sr-only sm:not-sr-only">{t('schedules.delete', 'Delete')}</span>
            </Button>
          </div>
          {!canManage ? (
            <p className="mx-auto max-w-2xl px-4 pt-4 text-[0.9em] text-muted-foreground sm:px-6">
              {t(
                'schedules.readOnly',
                'Only the owner can edit this schedule, using a machine with Schedule support.'
              )}
            </p>
          ) : null}
          {registry.runtimes
            .filter((r) => r === matchingScheduleRuntime(row, registry.runtimes) && r.blockedCode)
            .map((r) => (
              <p
                className="mx-auto mt-4 flex max-w-2xl items-start gap-2 rounded-lg border-[0.5px] border-status-warning/40 px-3 py-2 text-[0.9em] sm:px-4"
                key={r.machineId}
              >
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-status-warning" />
                <span>
                  {t(
                    `schedules.errors.${r.blockedCode}`,
                    'Check the target machine, Agent and Project, then save the schedule again.'
                  )}
                </span>
              </p>
            ))}
          <ScheduleEditor
            key={`${runtime?.workspaceId}:${scheduleId}:${row.activationId}`}
            document={detail.document}
            disabledReason={
              !isOwner
                ? t('schedules.ownerOnly', 'Only the schedule owner can save changes.')
                : !canManage
                  ? t('schedules.upgrade', 'Update the target machine’s CLI to edit schedules.')
                  : undefined
            }
            onSaved={open}
            onOpenSession={openSession}
          />
          <ScheduleSessionHistory scheduleId={scheduleId} />
        </div>
      )}
    </div>
  );
}

function ScheduleEditor({
  document,
  disabledReason,
  onSaved,
  onOpenSession,
}: {
  document?: ScheduleDocument;
  disabledReason?: string;
  onSaved: (id: string) => void;
  onOpenSession: (id: string) => void;
}) {
  const { t } = useTranslation();
  const activeRuntime = useAtomValue(activeWorkspaceRuntimeAtom);
  const scope = useResolvedWorkspaceScope();
  const runtime =
    scope.enabled && scope.workspaceId === activeRuntime?.workspaceId ? activeRuntime : null;
  const user = useAtomValue(userAtom);
  const agents = useAtomValue(getAllAgentConfigAtom) as AgentConfigMeta[];
  const { machines } = useVisibleMachineMetas({ includeMachineFlock: true });
  const local = useVisibleLocalProjects({ includeMachineFlock: true });
  const repos = useCloudQuery(
    cloudOperations.github.getWorkspaceRepositories,
    runtime ? { workspaceId: runtime.workspaceId } : 'skip'
  ) as { repoFullName?: string; fullName?: string }[] | null | undefined;
  const { openSettings } = useOpenSettings();
  const [agent, setAgent] = useState<AgentRunRef | null>(
    document
      ? {
          ...document.definition.agent,
          agentConfigId: document.definition.agent.agentConfigId as AgentConfigId,
        }
      : null
  );
  const [project, setProject] = useState<ProjectRef | null>(document?.definition.project ?? null);
  const [destination, setDestination] = useState<ScheduleDestination>(
    document?.definition.destination ?? DEFAULT_SCHEDULE_DESTINATION
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [identity] = useState(() => ({
    scheduleId: document?.definition.scheduleId ?? uuid(),
    activationId: uuid(),
    activityId: uuid(),
  }));
  const selected = agents.find((config) => config.id === agent?.agentConfigId);
  const machine = selected ? machines.get(selected.machineId) : undefined;

  // Chats runs may be appended to. Only the person's own, unarchived chats:
  // the daemon refuses any other owner, so offering them would only produce a
  // blocked schedule.
  const sessions = useAtomValue(sessionListAtom);
  const archivedSessions = useAtomValue(archivedSessionListAtom);
  const describeSession = (meta: SessionMeta): PickableSession => ({
    id: meta.id,
    title: meta.title || t('schedules.destination.untitledChat', 'Untitled chat'),
    detail: [
      agents.find((entry) => entry.id === meta.agentConfigId)?.name,
      machines.get(meta.machineId as never)?.name,
    ]
      .filter(Boolean)
      .join(' · '),
  });
  const pickableSessions = useMemo(
    () => sessions.filter((meta) => meta.userId === user?.id).map(describeSession),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- describeSession reads stable atoms
    [sessions, user?.id, agents, machines]
  );
  const ownSessionId =
    destination.kind === 'own_session'
      ? scheduleOwnSessionId(identity.scheduleId, destination.epoch)
      : undefined;
  const destinationMeta =
    destination.kind === 'existing_session'
      ? [...sessions, ...archivedSessions].find((meta) => meta.id === destination.sessionId)
      : ownSessionId
        ? [...sessions, ...archivedSessions].find((meta) => meta.id === ownSessionId)
        : undefined;
  const chooseDestination = (next: ScheduleDestination) => {
    setDestination(next);
    if (next.kind === 'existing_session' && next.sessionId) {
      const meta = sessions.find((entry) => entry.id === next.sessionId);
      // Follow the chat's Agent; the person still picks the permission mode.
      if (meta?.agentConfigId && meta.agentConfigId !== agent?.agentConfigId)
        setAgent({ agentConfigId: meta.agentConfigId as AgentConfigId });
    }
    if (next.kind !== 'new_session') setProject(null);
  };
  const machineLocalProjectIds = useMemo(
    () =>
      new Set(
        [...local.projects.values()]
          .filter((entry) => entry.machineId === selected?.machineId)
          .map((entry) => entry.project.id as string)
      ),
    [local.projects, selected?.machineId]
  );
  const saveBlockers = collectScheduleSaveBlockers(
    {
      disabledReason,
      workspaceReady: !!runtime,
      userId: user?.id,
      agent,
      agentConfig: selected ?? null,
      machine,
      project,
      machineLocalProjectIds,
      destination,
      // A chat with no recorded Agent cannot host appended turns; treat it as
      // driven by nothing, which the mismatch check then reports.
      destinationSession: destinationMeta
        ? {
            agentConfigId: destinationMeta.agentConfigId ?? '',
            machineId: destinationMeta.machineId,
          }
        : null,
    },
    t
  );
  const initial: ScheduleFormValue = useMemo(
    () =>
      document
        ? {
            title: document.definition.title,
            prompt: document.prompt,
            trigger: document.definition.trigger,
            misfire: document.definition.misfirePolicy.kind,
            overlap: document.definition.overlapPolicy,
          }
        : newScheduleFormValue(),
    [document]
  );
  const save = async (value: ScheduleFormValue) => {
    if (saving || saveBlockers.length || !runtime || !user || !selected || !agent) return;
    setSaving(true);
    setError(undefined);
    try {
      await runtime.withScheduleStore(
        identity.scheduleId,
        () =>
          new ScheduleRepository(runtime.repo, runtime.workspaceId).save({
            ...identity,
            actorId: user.id,
            now: getServerNow(),
            create: !document,
            draft: {
              title: value.title,
              prompt: value.prompt,
              trigger: value.trigger,
              machineId: selected.machineId,
              agent,
              ...(project && destination.kind === 'new_session' ? { project } : {}),
              destination,
              misfirePolicy: { kind: value.misfire },
              overlapPolicy: value.overlap,
              retryPolicy: { dispatchMaxAttempts: 5, dispatchMaxAgeMs: 86_400_000 },
            },
          }),
        { create: !document }
      );
      onSaved(identity.scheduleId);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t('schedules.saveError', 'The schedule could not be saved.')
      );
    } finally {
      setSaving(false);
    }
  };
  return (
    <ScheduleForm
      initial={initial}
      saving={saving}
      error={error}
      saveBlockers={saveBlockers}
      onSave={(value) => void save(value)}
      runConfig={
        <>
          <ScheduleDestinationRows
            value={destination}
            onChange={chooseDestination}
            sessions={pickableSessions}
            ownSession={
              destination.kind === 'own_session' && destinationMeta
                ? describeSession(destinationMeta)
                : null
            }
            pickedSession={
              destination.kind === 'existing_session' && destinationMeta
                ? describeSession(destinationMeta)
                : null
            }
            onOpenSession={onOpenSession}
            disabled={!!disabledReason}
          />
          <PropertyRowWide label={t('schedules.agent', 'Agent')}>
            <AgentRunConfigMenu
              requireExplicitPermission
              value={agent}
              onChange={(next) => {
                setAgent(next);
                if (
                  agents.find((a) => a.id === next.agentConfigId)?.machineId !== selected?.machineId
                )
                  setProject(null);
              }}
              disabled={!!disabledReason}
            />
          </PropertyRowWide>
          {destination.kind === 'new_session' ? (
            <PropertyRowWide label={t('schedules.project', 'Project')}>
              <ProjectRefSelector
                triggerVariant="property-row"
                value={project}
                onChange={setProject}
                localProjects={[...local.projects.values()]
                  .filter((entry) => entry.machineId === selected?.machineId)
                  .map((entry) => ({
                    key: entry.key,
                    machineId: entry.machineId,
                    localProjectId: entry.project.id,
                    name: entry.project.name,
                    rootPath: entry.project.rootPath,
                  }))}
                repositories={(repos ?? []).flatMap((r) =>
                  r.repoFullName || r.fullName
                    ? [{ fullName: (r.repoFullName ?? r.fullName)! }]
                    : []
                )}
                onAddLocalProject={() => openSettings('projects')}
                onConnectGitRepo={() => openSettings('github')}
              />
            </PropertyRowWide>
          ) : null}
          {project?.kind === 'local' ? (
            <PropertyRow
              label={t('schedules.worktreeLabel', 'Isolated worktree')}
              hint={
                project.useWorktree
                  ? undefined
                  : t(
                      'schedules.originalDirectory',
                      'Runs share the original directory. Work from other Agents may overlap here.'
                    )
              }
            >
              <Switch
                className="mr-2"
                checked={project.useWorktree === true}
                disabled={!!disabledReason}
                onCheckedChange={(checked) => setProject({ ...project, useWorktree: checked })}
                aria-label={t('schedules.worktree', 'Use an isolated Git worktree (recommended)')}
              />
            </PropertyRow>
          ) : null}
          {!project && destination.kind === 'new_session' ? (
            <p className="px-3 py-2 text-[0.8em] text-muted-foreground">
              {t(
                'schedules.chatOnlyHelp',
                'Without a project each run is a plain chat with the Agent — no repository is checked out.'
              )}
            </p>
          ) : null}
        </>
      }
    />
  );
}

function ScheduleSessionHistory({ scheduleId }: { scheduleId: string }) {
  const { t } = useTranslation();
  const sessions = useAtomValue(sessionListAtom);
  const archived = useAtomValue(archivedSessionListAtom);
  const slug = useAtomValue(currentWorkspaceSlugAtom);
  const navigate = useNavigate();
  const linked = [...sessions, ...archived]
    .filter((s) => s.scheduleId === scheduleId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <section className="mx-auto w-full max-w-2xl px-4 pb-8 sm:px-6">
      <h2 className="mb-1.5 px-1 text-[0.75em] font-normal text-muted-foreground">
        {t('schedules.history', 'Run history')}
      </h2>
      {linked.length === 0 ? (
        <p className={cn(scheduleCardClass, 'px-3 py-3 text-[0.9em] text-muted-foreground')}>
          {t('schedules.noRuns', 'No Sessions have been created yet.')}
        </p>
      ) : (
        <div className={scheduleCardClass}>
          {linked.slice(0, 100).map((s) => (
            <ScheduleHistoryRow
              key={s.id}
              session={s}
              onOpen={() => {
                if (slug)
                  void navigate({
                    to: '/$workspaceName/sessions/$sessionId',
                    params: { workspaceName: slug, sessionId: s.id },
                  });
              }}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ScheduleHistoryRow({ session: s, onOpen }: { session: SessionMeta; onOpen: () => void }) {
  const { t } = useTranslation();
  const liveStatus = useAtomValue(sessionLiveStatusAtomFamily(s.id));
  return (
    <button
      key={s.id}
      className="flex w-full items-center gap-3 px-3 py-2 text-left text-[0.9em] transition-colors hover:bg-foreground/[0.03] dark:hover:bg-white/[0.04]"
      onClick={onOpen}
    >
      <span className="min-w-0 flex-1 truncate">
        {s.title || t('schedules.openRun', 'Open run')}
      </span>
      <span className="shrink-0 text-[0.85em] text-muted-foreground">
        {liveStatus
          ? t(`schedules.sessionState.${liveStatus.type}`, liveStatus.type)
          : t('schedules.sessionState.inactive', 'Inactive')}
      </span>
      <time className="shrink-0 text-[0.85em] tabular-nums text-muted-foreground">
        {new Date(s.createdAt).toLocaleString(undefined, {
          dateStyle: 'short',
          timeStyle: 'short',
        })}
      </time>
    </button>
  );
}

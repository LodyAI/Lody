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
import { ArrowLeft, X } from 'lucide-react';
import { useCloudQuery } from '@lody/platform/react';
import {
  getAcpCapabilityCacheKey,
  getStaticBuiltinAcpCapabilities,
  hasExplicitSchedulePermission,
  scheduleUsesElevatedPermissions,
  getServerNow,
  machineSupportsSchedulesProtocol,
  ScheduleRepository,
  type SessionId,
  type SessionMeta,
  type AgentConfigId,
  type AgentConfigMeta,
  type ProjectRef,
  type ScheduleDocument,
  type ScheduleRegistryRow,
  type TaskAgentRef,
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
import {
  ScheduleForm,
  ScheduleListView,
  matchingScheduleRuntime,
  type ScheduleFormValue,
} from './schedule-view';

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
    if (!row.enabled && row.elevatedPermissions)
      setConfirmation({
        title: t('schedules.resume', 'Resume'),
        description: t(
          'schedules.elevatedHelp',
          'This Agent can run with elevated permissions without asking you each time. Confirm that you trust this prompt and Project.'
        ),
        accept: apply,
      });
    else void mutate(apply);
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
    <div className="flex h-full min-h-0 flex-col bg-background">
      {mobile ? (
        scheduleId ? (
          <Button className="self-start m-2" variant="ghost" onClick={() => open()}>
            <ArrowLeft className="size-4" />
            {t('schedules.all', 'All schedules')}
          </Button>
        ) : null
      ) : (
        <nav
          className="flex shrink-0 items-center gap-1 overflow-x-auto border-b px-3 py-2"
          aria-label={t('schedules.tabs', 'Schedule tabs')}
        >
          <Button size="sm" variant={!scheduleId ? 'secondary' : 'ghost'} onClick={() => open()}>
            {t('schedules.all', 'All schedules')}
          </Button>
          {tabs.map((id) => (
            <div key={id} className="flex items-center">
              <Button
                size="sm"
                variant={scheduleId === id ? 'secondary' : 'ghost'}
                onClick={() => open(id)}
              >
                {id === 'new'
                  ? t('schedules.new', 'New schedule')
                  : (registry.rows.find((r) => r.scheduleId === id)?.title ??
                    t('schedules.title', 'Schedules'))}
              </Button>
              <button
                className="p-1"
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
        <p className="px-5 py-2 text-sm text-destructive" role="alert">
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
            project:
              item.projectKind === 'local'
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
          <ScheduleEditor key={`${runtime?.workspaceId}:new`} onSaved={open} />
        </div>
      ) : !detail.ready ? (
        <p className="p-5">{t('schedules.loading', 'Loading schedules…')}</p>
      ) : !detail.document || !row ? (
        <p className="p-5">{t('schedules.notFound', 'This schedule is unavailable or deleted.')}</p>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="flex flex-wrap items-center gap-2 border-b px-5 py-3">
            <span className="mr-auto text-sm">
              {row.enabled ? t('schedules.enabled', 'Enabled') : t('schedules.paused', 'Paused')}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={row.enabled ? !isOwner : !canManage}
              onClick={() => toggle(row)}
            >
              {row.enabled ? t('schedules.pause', 'Pause') : t('schedules.resume', 'Resume')}
            </Button>
            <Button
              size="sm"
              variant="outline"
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
              {t('schedules.runNow', 'Run now')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
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
              {t('schedules.delete', 'Delete')}
            </Button>
          </div>
          {!canManage ? (
            <p className="px-5 pt-4 text-sm text-muted-foreground">
              {t(
                'schedules.readOnly',
                'Only the owner can edit this schedule, using a machine with Schedule support.'
              )}
            </p>
          ) : null}
          {registry.runtimes
            .filter((r) => r === matchingScheduleRuntime(row, registry.runtimes) && r.blockedCode)
            .map((r) => (
              <p className="px-5 pt-4 text-sm" key={r.machineId}>
                {t('schedules.blocked', 'Waiting for the machine to resolve a problem')}:{' '}
                {t(
                  `schedules.errors.${r.blockedCode}`,
                  'Check the target machine, Agent and Project, then save the schedule again.'
                )}
              </p>
            ))}
          <p className="px-5 pt-4 text-xs text-muted-foreground">
            {t(
              'schedules.pauseHelp',
              'Pausing stops future runs. Cancel already submitted Sessions separately.'
            )}
          </p>
          <ScheduleEditor
            key={`${runtime?.workspaceId}:${scheduleId}:${row.activationId}`}
            document={detail.document}
            disabled={!canManage}
            onSaved={open}
          />
          <ScheduleSessionHistory scheduleId={scheduleId} />
        </div>
      )}
    </div>
  );
}

function ScheduleEditor({
  document,
  disabled,
  onSaved,
}: {
  document?: ScheduleDocument;
  disabled?: boolean;
  onSaved: (id: string) => void;
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
  const [agent, setAgent] = useState<TaskAgentRef | null>(
    document
      ? {
          ...document.definition.agent,
          agentConfigId: document.definition.agent.agentConfigId as AgentConfigId,
        }
      : null
  );
  const [project, setProject] = useState<ProjectRef | null>(document?.definition.project ?? null);
  const [saving, setSaving] = useState(false);
  const [directoryConsent, setDirectoryConsent] = useState(false);
  const [error, setError] = useState<string>();
  const [identity] = useState(() => ({
    scheduleId: document?.definition.scheduleId ?? uuid(),
    activationId: uuid(),
    activityId: uuid(),
  }));
  const selected = agents.find((config) => config.id === agent?.agentConfigId);
  const available =
    !!selected &&
    machines.get(selected.machineId)?.ownerUserId === user?.id &&
    machineSupportsSchedulesProtocol(machines.get(selected.machineId));
  const initial: ScheduleFormValue = document
    ? {
        title: document.definition.title,
        prompt: document.prompt,
        trigger: document.definition.trigger,
        misfire: document.definition.misfirePolicy.kind,
        overlap: document.definition.overlapPolicy,
      }
    : {
        title: '',
        prompt: '',
        trigger: {
          kind: 'cron',
          expression: '0 9 * * *',
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        misfire: 'run_once',
        overlap: 'queue_one',
      };
  const save = async (value: ScheduleFormValue) => {
    if (!runtime || !user || !selected || !agent || !project) return;
    setSaving(true);
    setError(undefined);
    try {
      if (!available)
        throw new Error(
          t('schedules.upgrade', 'Update the target machine’s CLI to edit schedules.')
        );
      if (
        !hasExplicitSchedulePermission(
          agent,
          machines.get(selected.machineId)?.acpCapabilities?.[
            getAcpCapabilityCacheKey(selected.id)
          ] ??
            getStaticBuiltinAcpCapabilities(
              selected.cliType,
              selected.agentType,
              selected.runtimeOverrides
            )
        )
      )
        throw new Error(t('schedules.choosePermission', 'Choose an explicit permission mode.'));
      if (
        project.kind === 'local' &&
        ![...local.projects.values()].some(
          (entry) =>
            entry.machineId === selected.machineId && entry.project.id === project.localProjectId
        )
      )
        throw new Error(t('schedules.projectMachine', 'Choose a Project on the selected machine.'));
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
              project,
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
      disabled={
        disabled ||
        !available ||
        !project ||
        !agent ||
        (project?.kind === 'local' && !project.useWorktree && !directoryConsent)
      }
      onSave={(value) => void save(value)}
      selectors={
        <div className="space-y-4">
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
            disabled={disabled}
          />
          <ProjectRefSelector
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
              r.repoFullName || r.fullName ? [{ fullName: (r.repoFullName ?? r.fullName)! }] : []
            )}
            onAddLocalProject={() => openSettings('projects')}
            onConnectGitRepo={() => openSettings('github')}
          />
          {agent && scheduleUsesElevatedPermissions(agent) ? (
            <p className="text-sm text-status-warning">
              {t(
                'schedules.elevatedHelp',
                'This Agent can run with elevated permissions without asking you each time. Confirm that you trust this prompt and Project.'
              )}
            </p>
          ) : null}
          {project?.kind === 'local' ? (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={project.useWorktree === true}
                onChange={(e) => setProject({ ...project, useWorktree: e.target.checked })}
              />
              {t('schedules.worktree', 'Use an isolated Git worktree (recommended)')}
            </label>
          ) : null}
          {project?.kind === 'local' && !project.useWorktree ? (
            <p className="text-xs text-muted-foreground">
              {t(
                'schedules.originalDirectory',
                'Runs share the original directory. Work from other Agents may overlap here.'
              )}
            </p>
          ) : null}
          {project?.kind === 'local' && !project.useWorktree ? (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={directoryConsent}
                onChange={(e) => setDirectoryConsent(e.target.checked)}
              />
              {t(
                'schedules.directoryConsent',
                'Allow this schedule to work in the original Project directory.'
              )}
            </label>
          ) : null}
          {selected && !available ? (
            <p className="text-sm">
              {t('schedules.ownedMachine', 'Choose your own machine with Schedule support.')}
            </p>
          ) : null}
        </div>
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
    <section className="mx-auto max-w-3xl border-t px-5 py-6">
      <h2 className="mb-3 text-sm font-medium">{t('schedules.history', 'Run history')}</h2>
      {linked.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t('schedules.noRuns', 'No Sessions have been created yet.')}
        </p>
      ) : (
        linked.slice(0, 100).map((s) => (
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
        ))
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
      className="flex w-full items-center justify-between border-b py-3 text-left text-sm"
      onClick={onOpen}
    >
      <span>
        {s.title || t('schedules.openRun', 'Open run')}
        <span className="block text-xs text-muted-foreground">
          {liveStatus
            ? t(`schedules.sessionState.${liveStatus.type}`, liveStatus.type)
            : t('schedules.sessionState.inactive', 'Inactive')}
        </span>
      </span>
      <time>{new Date(s.createdAt).toLocaleString()}</time>
    </button>
  );
}

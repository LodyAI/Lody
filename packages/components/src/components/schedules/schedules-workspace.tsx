import type { AgentRunRef } from '@/components/shared/agent-run-ref';
import { AlertDialog } from '@/ui/dialog';
import { useIsMobile } from '@/hooks/use-mobile';
import { useCommand } from '@/lib/commands';
import { useEffect, useMemo, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { toast } from '@/lib/toast';
import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { v4 as uuid } from 'uuid';
import { AlertTriangle } from 'lucide-react';
import { useCloudQuery } from '@lody/platform/react';
import {
  DEFAULT_SCHEDULE_DESTINATION,
  getDeviceTimeZone,
  getServerNow,
  machineSupportsSchedulesProtocol,
  scheduleOwnSessionId,
  ScheduleRepository,
  type SessionId,
  type SessionMeta,
  type AgentConfigId,
  type MachineId,
  type MachineViewMeta,
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
import { scheduleListColumnWidthsAtom, scheduleSplitListWidthAtom } from '@/atoms/schedules';
import { mobileHomeReturnTabAtom } from '@/atoms/mobile-home-state';
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
import { DesktopMachineMenu } from '@/components/sessions/desktop-run-config-menu';
import { ProjectRefSelector } from '@/components/shared/project-ref-selector';
import { WorktreeCheckboxPill } from '@/components/shared/workdir-mode-selector';
import {
  ScheduleForm,
  ScheduleListView,
  matchingScheduleRuntime,
  newScheduleFormValue,
  type ScheduleFormValue,
} from './schedule-view';
import { scheduleCardProps } from './schedule-property-row';
import { ScheduleDetailToolbar, ScheduleSplitView } from './schedule-split-view';
import { collectScheduleSaveIssues, type ScheduleIssueField } from './schedule-save-blockers';
import { ScheduleDestinationRows, type PickableSession } from './schedule-destination-rows';
import { ScheduleAgentControls } from './schedule-agent-controls';
import { FieldIssueMark } from './schedule-field-issue-mark';
import { pickScheduleAgent, seedScheduleAgentRunRef } from './schedule-agent-defaults';
import { readChatLandingDefaults } from '@/lib/chat-landing-defaults';

const DARK =
  ':where(.dark, .dark *, .dark-scope, .dark-scope *):not(:where(.light-scope, .light-scope *))';

const styles = stylex.create({
  mobileDetail: {
    display: 'flex',
    flexDirection: 'column',
    boxSizing: 'border-box',
    height: '100%',
    minHeight: 0,
    // Mobile detail owns its top edge; desktop insets belong to the workspace shell.
    paddingTop: 'var(--safe-area-top, 0px)',
  },
  loadingMessage: { padding: '20px' },
  readOnlyMessage: {
    width: '100%',
    maxWidth: '672px',
    marginLeft: 'auto',
    marginRight: 'auto',
    paddingLeft: {
      default: '16px',
      '@media (min-width: 640px)': '24px',
    },
    paddingRight: {
      default: '16px',
      '@media (min-width: 640px)': '24px',
    },
    paddingTop: '16px',
    fontSize: '0.9em',
    color: 'hsl(var(--muted-foreground))',
  },
  blockedMessage: {
    display: 'flex',
    maxWidth: '672px',
    alignItems: 'flex-start',
    columnGap: '8px',
    marginLeft: 'auto',
    marginRight: 'auto',
    marginTop: '16px',
    borderWidth: '0.5px',
    borderStyle: 'solid',
    borderColor: 'hsl(var(--status-warning) / 0.4)',
    borderRadius: 'var(--radius-lg)',
    paddingLeft: {
      default: '12px',
      '@media (min-width: 640px)': '16px',
    },
    paddingRight: {
      default: '12px',
      '@media (min-width: 640px)': '16px',
    },
    paddingTop: '8px',
    paddingBottom: '8px',
    fontSize: '0.9em',
  },
  warningIcon: {
    marginTop: '2px',
    width: '14px',
    height: '14px',
    flexShrink: 0,
    color: 'hsl(var(--status-warning))',
  },
  detailContent: { minHeight: 0, flex: '1 1 0%', overflow: 'auto' },
  page: {
    display: 'flex',
    height: '100%',
    minHeight: 0,
    flexDirection: 'column',
    backgroundColor: 'hsl(var(--background))',
  },
  errorNotice: {
    paddingLeft: '20px',
    paddingRight: '20px',
    paddingTop: '8px',
    paddingBottom: '8px',
    fontSize: '1em',
    color: 'hsl(var(--destructive))',
  },
  content: { minHeight: 0, flex: '1 1 0%' },
  history: {
    width: '100%',
    maxWidth: '672px',
    marginLeft: 'auto',
    marginRight: 'auto',
    paddingLeft: {
      default: '16px',
      '@media (min-width: 640px)': '24px',
    },
    paddingRight: {
      default: '16px',
      '@media (min-width: 640px)': '24px',
    },
    paddingBottom: '32px',
  },
  historyTitle: {
    marginBottom: '6px',
    paddingLeft: '12px',
    paddingRight: '12px',
    fontSize: '0.8em',
    fontWeight: 400,
    color: 'hsl(var(--muted-foreground))',
  },
  noRuns: { padding: '12px', fontSize: '0.9em', color: 'hsl(var(--muted-foreground))' },
  historyRow: {
    display: 'flex',
    width: '100%',
    alignItems: 'center',
    columnGap: '12px',
    paddingLeft: '12px',
    paddingRight: '12px',
    paddingTop: '8px',
    paddingBottom: '8px',
    textAlign: 'left',
    fontSize: '0.9em',
    transitionProperty: 'background-color',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
    backgroundColor: {
      default: 'transparent',
      ':hover': {
        default: 'hsl(var(--foreground) / 0.03)',
        [DARK]: 'hsl(0 0% 100% / 0.04)',
      },
    },
  },
  historyTitleText: {
    minWidth: 0,
    flex: '1 1 0%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  historyMeta: { flexShrink: 0, fontSize: '0.85em', color: 'hsl(var(--muted-foreground))' },
  historyTime: {
    flexShrink: 0,
    fontSize: '0.85em',
    fontVariantNumeric: 'tabular-nums',
    color: 'hsl(var(--muted-foreground))',
  },
});

export function SchedulesWorkspace({
  scheduleId,
  insetSafeArea = false,
  hideHeader = false,
  query,
  createScheduleRef,
}: {
  scheduleId?: string;
  /**
   * The `/schedules` route on a phone has no shell inset. The home tab
   * already clears the status bar with its own header, so it leaves this off.
   */
  insetSafeArea?: boolean;
  /** Home tab supplies the search field and the new-schedule button. */
  hideHeader?: boolean;
  /** Home search text. Omit so the list keeps its own field. */
  query?: string;
  /** Home header plus button calls this. Assigned while this list is mounted. */
  createScheduleRef?: { current: (() => void) | null };
}) {
  const { t } = useTranslation();
  const activeRuntime = useAtomValue(activeWorkspaceRuntimeAtom);
  const scope = useResolvedWorkspaceScope();
  const runtime =
    scope.enabled && scope.workspaceId === activeRuntime?.workspaceId ? activeRuntime : null;
  const user = useAtomValue(userAtom);
  const slug = useAtomValue(currentWorkspaceSlugAtom);
  const navigate = useNavigate();
  const setReturnTab = useSetAtom(mobileHomeReturnTabAtom);
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
  const [error, setError] = useState<string>();
  const [confirmation, setConfirmation] = useState<{
    title: string;
    description: string;
    accept: () => Promise<void>;
    /** Red answer for an irreversible action. */
    destructive?: boolean;
    confirmLabel?: string;
  }>();
  const { machines } = useVisibleMachineMetas({ includeMachineFlock: true });
  const repository = useMemo(
    () => (runtime ? new ScheduleRepository(runtime.repo, runtime.workspaceId) : null),
    [runtime]
  );
  // Phone list lives on the home schedules tab (workspace switch, search,
  // settings, bottom bar). Closing or saving replaces this page with that
  // tab. Desktop still returns to the schedules route.
  const open = (id?: string) => {
    if (!slug) return;
    if (!id && mobile) {
      setReturnTab('schedules');
      void navigate({
        to: '/$workspaceName/chat',
        params: { workspaceName: slug },
        replace: true,
      });
      return;
    }
    void navigate(
      id
        ? {
            to: '/$workspaceName/schedules/$scheduleId',
            params: { workspaceName: slug, scheduleId: id },
          }
        : { to: '/$workspaceName/schedules', params: { workspaceName: slug } }
    );
  };
  if (createScheduleRef) createScheduleRef.current = () => open('new');
  useEffect(() => {
    if (!createScheduleRef) return undefined;
    return () => {
      createScheduleRef.current = null;
    };
  }, [createScheduleRef]);
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
  const requestRun = (id: string) => async () => {
    if (!repository || !user) return;
    await runtime!.withScheduleStore(id, () =>
      repository.requestRun({
        scheduleId: id,
        actorId: user.id,
        manualRunId: uuid(),
        now: getServerNow(),
      })
    );
  };
  const deleteSchedule = (id: string) => async () => {
    if (!repository || !user) return;
    await runtime!.withScheduleStore(id, () => repository.delete(id, user.id, getServerNow()));
    if (scheduleId === id) open();
  };
  // From the list there are no unsaved edits to warn about, so Run starts at
  // once and says so; the detail dialog still confirms (its edits may be unsaved).
  const runFromList = (item: ScheduleRegistryRow) =>
    void mutate(async () => {
      await requestRun(item.scheduleId)();
      toast.success(
        t('schedules.runStarted', 'Run requested for “{{title}}”.', { title: item.title })
      );
    });
  const confirmDelete = (item: ScheduleRegistryRow) =>
    setConfirmation({
      title: t('schedules.deleteTitle', 'Delete “{{title}}”?', { title: item.title }),
      description: t(
        'schedules.deleteHelp',
        'Future runs stop and the schedule is removed. Chats it already started are kept.'
      ),
      accept: deleteSchedule(item.scheduleId),
      destructive: true,
      confirmLabel: t('schedules.delete', 'Delete'),
    });
  const [columnWidths, setColumnWidths] = useAtom(scheduleListColumnWidthsAtom);
  const [splitListWidth, setSplitListWidth] = useAtom(scheduleSplitListWidthAtom);
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
  // Saving or closing returns to the list: beside the editor on desktop, and
  // the home schedules tab on a phone.
  const content = !scheduleId ? null : scheduleId === 'new' ? (
    <ScheduleEditor
      key={`${runtime?.workspaceId}:new`}
      onSaved={() => open()}
      onOpenSession={openSession}
    />
  ) : !detail.ready ? (
    <p {...stylex.props(styles.loadingMessage)}>{t('schedules.loading', 'Loading schedules…')}</p>
  ) : !detail.document || !row ? (
    <p {...stylex.props(styles.loadingMessage)}>
      {t('schedules.notFound', 'This schedule is unavailable or deleted.')}
    </p>
  ) : (
    <>
      {!canManage ? (
        <p {...stylex.props(styles.readOnlyMessage)}>
          {t(
            'schedules.readOnly',
            'Only the owner can edit this schedule, using a machine with Schedule support.'
          )}
        </p>
      ) : null}
      {registry.runtimes
        .filter((r) => r === matchingScheduleRuntime(row, registry.runtimes) && r.blockedCode)
        .map((r) => (
          <p {...stylex.props(styles.blockedMessage)} key={r.machineId}>
            <AlertTriangle {...stylex.props(styles.warningIcon)} />
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
        onSaved={() => open()}
        onOpenSession={openSession}
      />
      <ScheduleSessionHistory scheduleId={scheduleId} />
    </>
  );
  const detailPane = (
    <>
      <ScheduleDetailToolbar
        onClose={() => open()}
        paused={row ? !row.enabled : false}
        actions={
          row && scheduleId !== 'new'
            ? {
                enabled: row.enabled,
                canToggle: row.enabled ? isOwner : canManage,
                canRun: canManage,
                canDelete: isOwner,
                onToggle: () => toggle(row),
                onRun: () =>
                  setConfirmation({
                    title: t('schedules.runNow', 'Run now'),
                    description: t(
                      'schedules.runNowHelp',
                      'Run with the last saved prompt, Agent, Project and permission mode. Unsaved edits are excluded. This may run alongside existing work.'
                    ),
                    accept: requestRun(row.scheduleId),
                  }),
                onDelete: () => confirmDelete(row),
              }
            : undefined
        }
      />
      <div data-settings-surface="" {...stylex.props(styles.detailContent)}>
        {content}
      </div>
    </>
  );
  const list = (
    <ScheduleListView
      {...registry}
      onBlankClick={scheduleId && !mobile ? () => open() : undefined}
      renderBody={
        mobile
          ? undefined
          : (table) => (
              <ScheduleSplitView
                open={!!scheduleId}
                list={table}
                detail={detailPane}
                listWidth={splitListWidth ?? undefined}
                onListWidthChange={setSplitListWidth}
              />
            )
      }
      selectedId={scheduleId}
      onOpen={open}
      onNew={() => open('new')}
      onToggle={toggle}
      onRun={runFromList}
      onDelete={confirmDelete}
      columnWidths={columnWidths ?? undefined}
      onColumnWidthsChange={setColumnWidths}
      onOpenSession={openSession}
      insetSafeArea={mobile && insetSafeArea}
      hideHeader={hideHeader}
      query={query}
      contextForRow={(item) => ({
        machine: machines.get(item.machineId as never)?.name ?? item.machineId,
        timeZone: machines.get(item.machineId as never)?.timeZone,
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
        canRun:
          item.ownerId === user?.id &&
          machineSupportsSchedulesProtocol(machines.get(item.machineId as never)),
        canDelete: item.ownerId === user?.id,
        canToggle:
          item.ownerId === user?.id &&
          (item.enabled || machineSupportsSchedulesProtocol(machines.get(item.machineId as never))),
      })}
    />
  );
  return (
    <div {...stylex.props(styles.page)} data-settings-surface="">
      <AlertDialog.Root
        open={!!confirmation}
        onOpenChange={(isOpen) => {
          if (!isOpen) setConfirmation(undefined);
        }}
      >
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>{confirmation?.title}</AlertDialog.Title>
            <AlertDialog.Description>{confirmation?.description}</AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Footer>
            <AlertDialog.Cancel>{t('schedules.cancel', 'Cancel')}</AlertDialog.Cancel>
            <AlertDialog.Action
              variant={confirmation?.destructive ? 'destructive' : 'primary'}
              onClick={() => {
                const action = confirmation?.accept;
                if (action) void mutate(action);
              }}
            >
              {confirmation?.confirmLabel ?? t('schedules.confirm', 'Confirm')}
            </AlertDialog.Action>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
      {error ? (
        <p {...stylex.props(styles.errorNotice)} role="alert">
          {error}
        </p>
      ) : null}
      <div {...stylex.props(styles.content)}>
        {mobile && scheduleId ? (
          <div {...stylex.props(styles.mobileDetail)}>{detailPane}</div>
        ) : (
          list
        )}
      </div>
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
  // The machine is its own choice, as on the chat landing; the Agent is picked
  // among that machine's agents. Until an Agent exists it is chosen directly.
  // Schedules run only on the person's own machines, so only those are offered.
  const machineOptions = useMemo(
    () =>
      [...machines.values()]
        .filter(
          (entry) =>
            entry.ownerUserId === user?.id && agents.some((config) => config.machineId === entry.id)
        )
        .map((entry) => ({ value: entry.id as MachineId, label: entry.name })),
    [agents, machines, user?.id]
  );
  const [pickedMachineId, setPickedMachineId] = useState<MachineId | null>(null);
  const machineId =
    (selected?.machineId as MachineId | undefined) ??
    pickedMachineId ??
    (machineOptions.length === 1 ? machineOptions[0]!.value : null);
  const machine = machineId ? machines.get(machineId) : undefined;
  const machineAgents = useMemo(
    () =>
      agents
        .filter((config) => config.machineId === machineId)
        .sort((left, right) => left.name.localeCompare(right.name)),
    [agents, machineId]
  );
  // The person's own machines, the only ones a schedule may run on.
  const ownedMachines = useMemo(
    () => new Map([...machines].filter(([, entry]) => entry.ownerUserId === user?.id)),
    [machines, user?.id]
  );
  const seedAgentOn = (machineMeta: MachineViewMeta, preferredAgentId?: string | null) => {
    const config = pickScheduleAgent({
      landing: { agentId: preferredAgentId, machineId: machineMeta.id },
      agents,
      machines: new Map([[machineMeta.id, machineMeta]]),
    });
    setAgent(config ? seedScheduleAgentRunRef(config, machineMeta) : null);
  };
  const chooseMachine = (next: MachineId) => {
    if (next === machineId) return;
    setPickedMachineId(next);
    // A local project belongs to one machine; an Agent too, so the new machine
    // gets the Agent the chat landing would pick there, already configured.
    if (project?.kind === 'local') setProject(null);
    const nextMachine = machines.get(next);
    if (nextMachine) seedAgentOn(nextMachine, agent?.agentConfigId);
    else setAgent(null);
  };
  // A new schedule opens as the chat landing last left things: its machine and
  // Agent with that Agent's remembered model, options and permission. Seeded
  // once, after the catalogs arrive (they can load after the editor mounts).
  const [seeded, setSeeded] = useState(!!document);
  useEffect(() => {
    if (seeded || agent || !user?.id || ownedMachines.size === 0 || agents.length === 0) return;
    setSeeded(true);
    const config = pickScheduleAgent({
      landing: readChatLandingDefaults(runtime?.workspaceId),
      agents,
      machines: ownedMachines,
    });
    if (config) setAgent(seedScheduleAgentRunRef(config, machines.get(config.machineId)));
  }, [agent, agents, machines, ownedMachines, runtime?.workspaceId, seeded, user?.id]);

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
  const issues = collectScheduleSaveIssues(
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
    if (saving || issues.length || !runtime || !user || !selected || !agent) return;
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
  // A mark shows next to the control that fixes it; an unfinished choice only
  // once the person tried to save.
  const issuesFor = (field: ScheduleIssueField, revealMissing: boolean) =>
    issues
      .filter((issue) => issue.field === field && (issue.kind === 'invalid' || revealMissing))
      .map((issue) => issue.message);
  const ownSession =
    destination.kind === 'own_session' && destinationMeta ? describeSession(destinationMeta) : null;
  const pickedSession =
    destination.kind === 'existing_session' && destinationMeta
      ? describeSession(destinationMeta)
      : null;
  const note =
    destination.kind !== 'new_session'
      ? undefined
      : project?.kind === 'local' && !project.useWorktree
        ? t(
            'schedules.originalDirectory',
            'Runs share the original directory. Work from other Agents may overlap here.'
          )
        : !project
          ? t(
              'schedules.chatOnlyHelp',
              'Without a project each run is a plain chat with the Agent — no repository is checked out.'
            )
          : undefined;
  return (
    <ScheduleForm
      initial={initial}
      saving={saving}
      error={error}
      issues={issues}
      autoFocus={!document}
      timeZone={machine?.timeZone ?? getDeviceTimeZone()}
      clockName={machine?.name}
      contextNote={note}
      onSave={(value) => void save(value)}
      agentBar={({ revealMissing }) => (
        <>
          <ScheduleAgentControls
            machine={machine}
            agentConfigs={machineAgents}
            value={agent}
            onChange={setAgent}
            disabledReason={
              disabledReason ??
              (machine
                ? undefined
                : t('chat.machineSelector.selectFirst', 'Select a machine first'))
            }
          />
          <FieldIssueMark messages={issuesFor('agent', revealMissing)} />
        </>
      )}
      contextBar={({ revealMissing }) => (
        <>
          <DesktopMachineMenu
            value={machineId}
            options={machineOptions}
            selectedLabel={machine?.name}
            onChange={chooseMachine}
            disabled={!!disabledReason}
          />
          <FieldIssueMark messages={issuesFor('machine', revealMissing)} />
          {destination.kind === 'new_session' ? (
            <>
              <ProjectRefSelector
                triggerVariant="chip"
                value={project}
                onChange={setProject}
                localProjects={[...local.projects.values()]
                  .filter((entry) => entry.machineId === machineId)
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
            </>
          ) : null}
          {project?.kind === 'local' && destination.kind === 'new_session' ? (
            <WorktreeCheckboxPill
              checked={project.useWorktree === true}
              disabled={!!disabledReason}
              onCheckedChange={(checked) => setProject({ ...project, useWorktree: checked })}
            />
          ) : null}
        </>
      )}
      destination={({ revealMissing }) => (
        <ScheduleDestinationRows
          value={destination}
          onChange={chooseDestination}
          sessions={pickableSessions}
          ownSession={ownSession}
          pickedSession={pickedSession}
          onOpenSession={onOpenSession}
          issues={issuesFor('destination', revealMissing)}
          disabled={!!disabledReason}
        />
      )}
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
  // Under the editor, at the bottom of the open schedule.
  return (
    <section {...stylex.props(styles.history)}>
      <h2 {...stylex.props(styles.historyTitle)}>{t('schedules.history', 'Run history')}</h2>
      {linked.length === 0 ? (
        <p {...scheduleCardProps(stylex.props(styles.noRuns).className)}>
          {t('schedules.noRuns', 'No Sessions have been created yet.')}
        </p>
      ) : (
        <div {...scheduleCardProps()}>
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
    <button key={s.id} {...stylex.props(styles.historyRow)} onClick={onOpen}>
      <span {...stylex.props(styles.historyTitleText)}>
        {s.title || t('schedules.openRun', 'Open run')}
      </span>
      <span {...stylex.props(styles.historyMeta)}>
        {liveStatus
          ? t(`schedules.sessionState.${liveStatus.type}`, liveStatus.type)
          : t('schedules.sessionState.inactive', 'Inactive')}
      </span>
      <time {...stylex.props(styles.historyTime)}>
        {new Date(s.createdAt).toLocaleString(undefined, {
          dateStyle: 'short',
          timeStyle: 'short',
        })}
      </time>
    </button>
  );
}

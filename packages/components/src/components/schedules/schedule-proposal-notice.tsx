import { useCallback, useEffect, useMemo, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useAtomValue } from 'jotai';
import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { CalendarClock } from 'lucide-react';
import { v4 as uuid } from 'uuid';
import {
  applyScheduleRecurrence,
  defaultScheduleRecurrence,
  getServerNow,
  resolveSessionConversationConfig,
  withScheduleRecurrenceTimeZone,
  type ScheduleRecurrence,
  type ScheduleTrigger,
  ScheduleRepository,
  getDeviceTimeZone,
  scheduleProposalRuleToRecurrence,
  scheduleProposalRuleToTrigger,
  getSessionRoomId,
  type AgentConfigMeta,
  type ScheduleProposalMeta,
  type SessionId,
} from '@lody/shared';
import { currentWorkspaceSlugAtom, userAtom } from '@/atoms';
import { getAllAgentConfigAtom } from '@/atoms/agents';
import { sessionMetaAtomFamily } from '@/atoms/doc-meta';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { useResolvedWorkspaceScope } from '@/hooks/use-resolved-workspace-scope';
import { useVisibleLocalProjects } from '@/hooks/use-visible-local-projects';
import { useVisibleMachineMetas } from '@/hooks/use-visible-machine-metas';
import { useWorkspaceAgentRoles } from '@/hooks/use-workspace-agent-roles';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { Tabs } from '@lody/ui/tabs';
import { Textarea } from '@lody/ui/textarea';
import { settingsCard } from '@/components/settings/compact-layout';
import { MarkdownRenderer } from '@/components/ai-gui/markdown-renderer';
import { describeDestination, describeRecurrence } from './schedule-format';
import {
  resolveScheduleProposalTarget,
  type ProposalConversation,
  type ProposalTargetProblem,
} from './schedule-proposal-target';
import { PropertyRow, scheduleCardProps } from './schedule-property-row';
import { ScheduleRecurrenceEditor } from './schedule-recurrence-editor';
import { collectScheduleSaveBlockers } from './schedule-save-blockers';

const DARK =
  ':where(.dark, .dark *, .dark-scope, .dark-scope *):not(:where(.light-scope, .light-scope *))';
const COLOR_MIX = '@supports (color: color-mix(in lab, red, red))';

const styles = stylex.create({
  receipt: {
    display: 'flex',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 2)',
    borderWidth: '0.5px',
    borderStyle: 'solid',
    borderColor: { default: 'hsl(var(--border) / 1)', [DARK]: 'transparent' },
    borderRadius: 'var(--radius-lg)',
    backgroundColor: {
      default: 'hsl(var(--card) / 1)',
      [DARK]: {
        default: 'hsl(var(--foreground) / 1)',
        [COLOR_MIX]: 'color-mix(in oklab, hsl(var(--foreground) / 1) 4%, transparent)',
      },
    },
    paddingInline: 'calc(var(--spacing) * 3)',
    paddingBlock: 'calc(var(--spacing) * 2)',
    fontSize: '0.9em',
    color: 'hsl(var(--muted-foreground) / 1)',
    boxShadow: {
      default:
        'var(--tw-inset-shadow, 0 0 #0000), var(--tw-inset-ring-shadow, 0 0 #0000), var(--tw-ring-offset-shadow, 0 0 #0000), var(--tw-ring-shadow, 0 0 #0000), 0 0.5px 1px 1px var(--tw-shadow-color, rgba(0, 0, 0, 0.03))',
      [DARK]:
        'var(--tw-inset-shadow, 0 0 #0000), var(--tw-inset-ring-shadow, 0 0 #0000), var(--tw-ring-offset-shadow, 0 0 #0000), var(--tw-ring-shadow, 0 0 #0000), 0 0 #0000',
    },
  },
  receiptTitle: {
    minWidth: 0,
    flex: '1',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: 'hsl(var(--foreground) / 1)',
  },
  dismissed: {
    display: 'flex',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 2)',
    borderWidth: '0.5px',
    borderStyle: 'solid',
    borderColor: {
      default: 'hsl(var(--border) / 1)',
      [DARK]: {
        default: 'hsl(var(--foreground) / 1)',
        [COLOR_MIX]: 'color-mix(in oklab, hsl(var(--foreground) / 1) 10%, transparent)',
      },
    },
    borderRadius: 'var(--radius-lg)',
    paddingInline: 'calc(var(--spacing) * 3)',
    paddingBlock: 'calc(var(--spacing) * 2)',
    fontSize: '0.9em',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
  dismissedTitle: {
    minWidth: 0,
    flex: '1',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    textDecorationLine: 'line-through',
  },
  proposalCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'calc(var(--spacing) * 2.5)',
    overflow: 'hidden',
    padding: 'calc(var(--spacing) * 3)',
  },
  proposalHeading: {
    display: 'flex',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 2)',
    fontSize: '0.8em',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
  proposedBy: {
    marginLeft: 'auto',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  proposalTitle: { margin: 0, fontSize: '1em', fontWeight: 400 },
  promptPreview: {
    maxHeight: 'calc(var(--spacing) * 40)',
    overflowY: 'auto',
    borderRadius: 'var(--radius-md)',
    backgroundColor: {
      default: 'hsl(var(--foreground) / 1)',
      [COLOR_MIX]: 'color-mix(in oklab, hsl(var(--foreground) / 1) 3%, transparent)',
      [DARK]: {
        default: 'color-mix(in srgb, #fff 4%, transparent)',
        [COLOR_MIX]: 'color-mix(in oklab, var(--color-white) 4%, transparent)',
      },
    },
    paddingInline: 'calc(var(--spacing) * 2.5)',
    paddingBlock: 'calc(var(--spacing) * 2)',
  },
  proposalRows: {
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0, 1fr)',
    columnGap: 'calc(var(--spacing) * 3)',
    rowGap: 'calc(var(--spacing) * 1)',
    fontSize: '0.9em',
  },
  proposalLabel: { color: 'hsl(var(--muted-foreground) / 1)' },
  proposalValue: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  contents: { display: 'contents' },
  reasons: {
    margin: 0,
    padding: 0,
    listStyleType: 'none',
    fontSize: '0.9em',
    color: 'hsl(var(--status-warning) / 1)',
  },
  reason: { marginBlockEnd: { default: 'calc(var(--spacing) * 0.5)', ':last-child': 0 } },
  actions: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 'calc(var(--spacing) * 2)',
  },
  icon: { width: 'calc(var(--spacing) * 3.5)', height: 'calc(var(--spacing) * 3.5)' },
});

export type ScheduleProposalNoticeProps = {
  meta: ScheduleProposalMeta;
  sessionId: SessionId;
  /** History entry carrying this notice, so the outcome can be written back. */
  entryId: string;
  itemIndex: number;
};

/**
 * An agent's proposal to schedule a task, rendered inline in the conversation.
 *
 * Pressing Create IS the creation — there is no form afterwards. The card
 * therefore shows exactly what will be created: the rule in words, where runs
 * go, and the Agent, mode and project it resolved (this conversation's unless
 * the person named others), and it refuses with the same reasons the editor
 * would rather than creating something that could not run.
 *
 * Before creating, Edit turns the card itself into a small form for the name,
 * the prompt and the time rule. The edits live in the card only — the notice
 * keeps the Agent's proposal, so a retried proposal still matches it — and
 * once created the card is a receipt with nothing left to edit.
 */
export function ScheduleProposalNotice({
  meta,
  sessionId,
  entryId,
  itemIndex,
}: ScheduleProposalNoticeProps) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const slug = useAtomValue(currentWorkspaceSlugAtom);
  const user = useAtomValue(userAtom);
  const activeRuntime = useAtomValue(activeWorkspaceRuntimeAtom);
  const scope = useResolvedWorkspaceScope();
  const runtime =
    scope.enabled && scope.workspaceId === activeRuntime?.workspaceId ? activeRuntime : null;
  const session = useAtomValue(sessionMetaAtomFamily(getSessionRoomId(sessionId)));
  const agents = useAtomValue(getAllAgentConfigAtom) as AgentConfigMeta[];
  const { roles } = useWorkspaceAgentRoles();
  const { machines } = useVisibleMachineMetas({ includeMachineFlock: true });
  const local = useVisibleLocalProjects({ includeMachineFlock: true });
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  // The person's edits, once they pressed Edit; the proposal itself otherwise.
  const [edit, setEdit] = useState<{
    title: string;
    prompt: string;
    manual: boolean;
    recurrence: ScheduleRecurrence;
  } | null>(null);
  // The conversation's effective run config (mode, model, options) lives in
  // its history, not its meta. It has to be read for DISPLAY too: the card
  // decides whether Create is allowed from it, and the same Agent with no mode
  // would otherwise sit behind "choose a permission mode" forever.
  const [runConfig, setRunConfig] = useState<ProposalConversation['runConfig']>({});
  useEffect(() => {
    if (!runtime) return undefined;
    let cancelled = false;
    void runtime
      .withSessionStore(sessionId, (store) => store.sessionData.history.readAll())
      .then((history) => {
        if (cancelled) return;
        const config = resolveSessionConversationConfig(history);
        setRunConfig({
          modeId: config.modeId,
          modelId: config.modelId,
          configOptionValues: config.configOptionValues,
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [runtime, sessionId]);
  const resolved = useMemo(
    () =>
      resolveScheduleProposalTarget({
        meta,
        conversation: session ? { session, runConfig } : null,
        agents,
        roles,
      }),
    [agents, meta, roles, runConfig, session]
  );
  const target = resolved.ok ? resolved.target : null;
  const machine = target ? machines.get(target.agentConfig.machineId) : undefined;
  // A rule the agent proposed without a zone runs on the target machine's clock.
  const machineTimeZone = machine?.timeZone ?? getDeviceTimeZone();
  const proposedRecurrence = useMemo(
    () => scheduleProposalRuleToRecurrence(meta.rule, machineTimeZone),
    [machineTimeZone, meta.rule]
  );
  const title = edit?.title ?? meta.title;
  const prompt = edit?.prompt ?? meta.prompt;
  // The rule that will be created, on the target machine's clock (null = manual).
  const recurrence = edit
    ? edit.manual
      ? null
      : withScheduleRecurrenceTimeZone(edit.recurrence, machineTimeZone)
    : proposedRecurrence;
  const startEditing = () => {
    setEdit(
      (current) =>
        current ?? {
          title: meta.title,
          prompt: meta.prompt,
          manual: proposedRecurrence === null,
          recurrence: proposedRecurrence ?? defaultScheduleRecurrence(machineTimeZone),
        }
    );
    setEditing(true);
  };
  // What an edited rule cannot become, said the way the editor says it.
  const editProblems = (() => {
    if (!edit) return [];
    const problems: string[] = [];
    if (!edit.title.trim()) problems.push(t('schedules.requireName', 'Enter a schedule name.'));
    if (!edit.prompt.trim())
      problems.push(t('schedules.requirePrompt', 'Describe what the Agent should do.'));
    if (recurrence) {
      try {
        applyScheduleRecurrence(recurrence, getServerNow());
      } catch {
        problems.push(
          recurrence.kind === 'weekly' && recurrence.weekdays.length === 0
            ? t('schedules.requireWeekday', 'Choose at least one day of the week.')
            : recurrence.kind === 'monthly' && recurrence.days.length === 0
              ? t('schedules.requireMonthDay', 'Choose at least one day of the month.')
              : t('schedules.invalidTime', 'Check the time rule and time zone.')
        );
      }
    }
    return problems;
  })();
  const machineLocalProjectIds = useMemo(
    () =>
      new Set(
        [...local.projects.values()]
          .filter((entry) => entry.machineId === target?.agentConfig.machineId)
          .map((entry) => entry.project.id as string)
      ),
    [local.projects, target?.agentConfig.machineId]
  );
  const blockers = target
    ? collectScheduleSaveBlockers(
        {
          workspaceReady: !!runtime,
          userId: user?.id,
          agent: target.agent,
          agentConfig: target.agentConfig,
          machine,
          project: target.project,
          machineLocalProjectIds,
          destination: target.destination,
        },
        t
      )
    : [];
  const problem: ProposalTargetProblem | null = resolved.ok ? null : resolved.problem;

  const writeOutcome = useCallback(
    async (next: ScheduleProposalMeta) => {
      if (!runtime) return;
      const read = await runtime.withSessionStore(sessionId, (store) =>
        store.sessionData.history.readTurn(entryId)
      );
      // Never return quietly: the schedule may already exist, and a card that
      // does not change reads as a Create button that does nothing.
      if (read.state !== 'ready') throw new Error('The proposal could not be read.');
      const entry = read.turn;
      const items = Array.isArray(entry.items) ? [...(entry.items as unknown[])] : [];
      const item = items[itemIndex];
      if (!item || typeof item !== 'object') throw new Error('The proposal could not be read.');
      items[itemIndex] = { ...(item as Record<string, unknown>), meta: next };
      const nextEntry = { ...entry, items } as unknown as Parameters<
        typeof runtime.writer.updateSessionHistory
      >[2];
      await runtime.writer.updateSessionHistory(sessionId, entryId, nextEntry);
    },
    [entryId, itemIndex, runtime, sessionId]
  );

  const openSchedule = useCallback(
    (scheduleId: string) => {
      if (slug)
        void navigate({
          to: '/$workspaceName/schedules/$scheduleId',
          params: { workspaceName: slug, scheduleId },
        });
    },
    [navigate, slug]
  );

  const create = useCallback(() => {
    void (async () => {
      if (!runtime || !user || !target || !session) return;
      setBusy(true);
      try {
        // Re-resolve from history at click time, so a mode changed since the
        // card rendered is the one that gets persisted.
        const history = await runtime.withSessionStore(sessionId, (store) =>
          store.sessionData.history.readAll()
        );
        const latest = resolveSessionConversationConfig(history);
        const final = resolveScheduleProposalTarget({
          meta,
          conversation: {
            session,
            runConfig: {
              modeId: latest.modeId,
              modelId: latest.modelId,
              configOptionValues: latest.configOptionValues,
            },
          },
          agents,
          roles,
        });
        if (!final.ok) return;
        const latestMachine = machines.get(final.target.agentConfig.machineId);
        const now = getServerNow();
        const clock = latestMachine?.timeZone ?? getDeviceTimeZone();
        const trigger: ScheduleTrigger = edit
          ? edit.manual
            ? { kind: 'manual' }
            : applyScheduleRecurrence(withScheduleRecurrenceTimeZone(edit.recurrence, clock), now)
          : scheduleProposalRuleToTrigger(meta.rule, now, clock);
        // The proposal id is the schedule id, so a double click or a retried
        // write cannot create two schedules.
        const scheduleId = meta.proposalId;
        await runtime.withScheduleStore(
          scheduleId,
          () =>
            new ScheduleRepository(runtime.repo, runtime.workspaceId).save({
              scheduleId,
              activationId: uuid(),
              activityId: `proposal-${meta.proposalId}`,
              actorId: user.id,
              now,
              create: true,
              draft: {
                title: title.trim(),
                prompt,
                trigger,
                machineId: final.target.agentConfig.machineId,
                agent: final.target.agent,
                ...(final.target.project ? { project: final.target.project } : {}),
                destination: final.target.destination,
                misfirePolicy: { kind: 'run_once' },
                overlapPolicy: 'queue_one',
                retryPolicy: { dispatchMaxAttempts: 5, dispatchMaxAgeMs: 86_400_000 },
              },
            }),
          { create: true }
        );
        await writeOutcome({ ...meta, outcome: 'created', scheduleId });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    })();
  }, [
    agents,
    edit,
    machines,
    meta,
    prompt,
    roles,
    runtime,
    session,
    sessionId,
    target,
    title,
    user,
    writeOutcome,
  ]);

  const dismiss = useCallback(() => {
    void (async () => {
      setBusy(true);
      try {
        await writeOutcome({ ...meta, outcome: 'dismissed' });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    })();
  }, [meta, writeOutcome]);

  if (meta.outcome === 'created') {
    return (
      <div data-settings-surface="" {...stylex.props(styles.receipt)}>
        <CalendarClock {...stylex.props(styles.icon)} />
        <span>{t('schedules.proposal.created', 'Scheduled task created')}</span>
        <span {...stylex.props(styles.receiptTitle)}>{meta.title}</span>
        {meta.scheduleId ? (
          <Button size="small" variant="ghost" onClick={() => openSchedule(meta.scheduleId!)}>
            {t('schedules.proposal.open', 'Open')}
          </Button>
        ) : null}
      </div>
    );
  }
  if (meta.outcome === 'dismissed') {
    return (
      <div {...stylex.props(styles.dismissed)}>
        <CalendarClock {...stylex.props(styles.icon)} />
        <span>{t('schedules.proposal.dismissed', 'Proposal ignored')}</span>
        <span {...stylex.props(styles.dismissedTitle)}>{meta.title}</span>
      </div>
    );
  }

  const problemText: Record<ProposalTargetProblem, string> = {
    role_not_found: t('schedules.proposal.roleNotFound', 'The named Agent Role no longer exists.'),
    agent_not_found: t('schedules.proposal.agentNotFound', 'The named Agent is not available.'),
    machine_mismatch: t(
      'schedules.proposal.machineMismatch',
      'That Agent does not run on the named machine.'
    ),
    no_agent: t('schedules.proposal.noAgent', 'This conversation has no Agent to run with.'),
  };
  const reasons = problem ? [problemText[problem]] : [...editProblems, ...blockers];
  const rows: [string, string][] = [
    // While editing, the rule has its own controls above.
    ...(editing
      ? []
      : [
          [
            t('schedules.trigger.label', 'Trigger'),
            recurrence
              ? describeRecurrence(recurrence, t, i18n.language, machineTimeZone)
              : t('schedules.trigger.manual', 'Manual'),
          ] as [string, string],
        ]),
    [
      t('schedules.sendTo', 'Send to'),
      describeDestination(target?.destination ?? { kind: 'new_session' }, t),
    ],
    [
      t('schedules.agent', 'Agent'),
      target
        ? [
            target.role ? `${target.role.emoji ?? ''} ${target.role.name}`.trim() : null,
            target.agentConfig.name,
            machine?.name,
          ]
            .filter(Boolean)
            .join(' · ')
        : '—',
    ],
    ...(target?.project
      ? [
          [
            t('schedules.project', 'Project'),
            target.project.kind === 'github'
              ? target.project.repoFullName
              : ([...local.projects.values()].find(
                  (entry) =>
                    entry.project.id ===
                    (target.project as { localProjectId: string }).localProjectId
                )?.project.name ?? target.project.localProjectId),
          ] as [string, string],
        ]
      : []),
  ];

  return (
    <div data-settings-surface="" {...stylex.props(settingsCard, styles.proposalCard)}>
      <div {...stylex.props(styles.proposalHeading)}>
        <CalendarClock {...stylex.props(styles.icon)} />
        <span>{t('schedules.proposal.title', 'Schedule this task?')}</span>
        {meta.proposedBy?.name ? (
          <span {...stylex.props(styles.proposedBy)}>
            {t('schedules.proposal.by', 'Proposed by {{name}}', { name: meta.proposedBy.name })}
          </span>
        ) : null}
      </div>
      {editing && edit ? (
        <>
          <Input
            size="small"
            aria-label={t('schedules.name', 'Name')}
            placeholder={t('schedules.namePlaceholder', 'Name this scheduled task')}
            maxLength={200}
            value={edit.title}
            onChange={(event) => setEdit({ ...edit, title: event.target.value })}
          />
          <Textarea
            rows={4}
            resize="vertical"
            aria-label={t('schedules.prompt', 'What should the Agent do?')}
            value={edit.prompt}
            onChange={(event) => setEdit({ ...edit, prompt: event.target.value })}
          />
          <div {...scheduleCardProps()}>
            <PropertyRow label={t('schedules.trigger.label', 'Trigger')}>
              <Tabs.Root
                value={edit.manual ? 'manual' : 'timed'}
                onValueChange={(next) => setEdit({ ...edit, manual: next === 'manual' })}
              >
                <Tabs.List size="small">
                  <Tabs.Tab value="timed">{t('schedules.trigger.timed', 'On a schedule')}</Tabs.Tab>
                  <Tabs.Tab value="manual">{t('schedules.trigger.manual', 'Manual')}</Tabs.Tab>
                </Tabs.List>
              </Tabs.Root>
            </PropertyRow>
            {edit.manual ? null : (
              <ScheduleRecurrenceEditor
                value={withScheduleRecurrenceTimeZone(edit.recurrence, machineTimeZone)}
                onChange={(next) => setEdit({ ...edit, recurrence: next })}
                now={getServerNow()}
                timeZone={machineTimeZone}
              />
            )}
          </div>
        </>
      ) : (
        <>
          <p {...stylex.props(styles.proposalTitle)}>{title}</p>
          <div {...stylex.props(styles.promptPreview)}>
            <MarkdownRenderer text={prompt} size="sm" />
          </div>
        </>
      )}
      <dl {...stylex.props(styles.proposalRows)}>
        {rows.map(([label, value]) => (
          <div key={label} {...stylex.props(styles.contents)}>
            <dt {...stylex.props(styles.proposalLabel)}>{label}</dt>
            <dd {...stylex.props(styles.proposalValue)}>{value}</dd>
          </div>
        ))}
      </dl>
      {reasons.length ? (
        <ul {...stylex.props(styles.reasons)} aria-live="polite">
          {reasons.map((reason) => (
            <li key={reason} {...stylex.props(styles.reason)}>
              {reason}
            </li>
          ))}
        </ul>
      ) : null}
      <div {...stylex.props(styles.actions)}>
        <Button size="small" variant="ghost" disabled={busy} onClick={dismiss}>
          {t('schedules.proposal.dismiss', 'Ignore')}
        </Button>
        {editing ? (
          <Button
            size="small"
            variant="secondary"
            disabled={busy}
            onClick={() => setEditing(false)}
          >
            {t('schedules.proposal.doneEditing', 'Done')}
          </Button>
        ) : (
          <Button size="small" variant="secondary" disabled={busy} onClick={startEditing}>
            {t('schedules.proposal.edit', 'Edit')}
          </Button>
        )}
        <Button
          size="small"
          variant="primary"
          disabled={busy || reasons.length > 0 || !target}
          onClick={create}
        >
          {t('schedules.proposal.create', 'Create')}
        </Button>
      </div>
    </div>
  );
}

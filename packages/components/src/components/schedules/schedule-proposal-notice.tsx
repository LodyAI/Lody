import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { CalendarClock } from 'lucide-react';
import { v4 as uuid } from 'uuid';
import {
  getServerNow,
  resolveSessionConversationConfig,
  ScheduleRepository,
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
import { Button } from '@/ui/button';
import { MarkdownRenderer } from '@/components/ai-gui/markdown-renderer';
import { describeDestination, describeRecurrence } from './schedule-format';
import {
  resolveScheduleProposalTarget,
  type ProposalConversation,
  type ProposalTargetProblem,
} from './schedule-proposal-target';
import { collectScheduleSaveBlockers } from './schedule-save-blockers';

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
  // The conversation's effective run config (mode, model, options) lives in
  // its history, not its meta. It has to be read for DISPLAY too: the card
  // decides whether Create is allowed from it, and the same Agent with no mode
  // would otherwise sit behind "choose a permission mode" forever.
  const [runConfig, setRunConfig] = useState<ProposalConversation['runConfig']>({});
  useEffect(() => {
    if (!runtime) return;
    let cancelled = false;
    void runtime
      .withSessionStore(sessionId, (store) => store.sessionData.history.readAll())
      .then((history) => {
        if (cancelled) return;
        const config = resolveSessionConversationConfig(history);
        setRunConfig({
          modeId: config.modeId,
          modelId: config.modelId,
          configOptionValues: config.configOptionValues as Record<string, string> | undefined,
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
  const recurrence = useMemo(() => scheduleProposalRuleToRecurrence(meta.rule), [meta.rule]);
  const target = resolved.ok ? resolved.target : null;
  const machine = target ? machines.get(target.agentConfig.machineId) : undefined;
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
      if (read.state !== 'ready') return;
      const entry = read.turn;
      const items = Array.isArray(entry.items) ? [...(entry.items as unknown[])] : [];
      const item = items[itemIndex];
      if (!item || typeof item !== 'object') return;
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
              configOptionValues: latest.configOptionValues as Record<string, string> | undefined,
            },
          },
          agents,
          roles,
        });
        if (!final.ok) return;
        const now = getServerNow();
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
                title: meta.title,
                prompt: meta.prompt,
                trigger: scheduleProposalRuleToTrigger(meta.rule, now),
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
  }, [agents, meta, roles, runtime, session, sessionId, target, user, writeOutcome]);

  const dismiss = useCallback(() => {
    void (async () => {
      setBusy(true);
      try {
        await writeOutcome({ ...meta, outcome: 'dismissed' });
      } finally {
        setBusy(false);
      }
    })();
  }, [meta, writeOutcome]);

  if (meta.outcome === 'created') {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
        <CalendarClock className="size-3.5" />
        <span>{t('schedules.proposal.created', 'Scheduled task created')}</span>
        <span className="min-w-0 flex-1 truncate text-foreground">{meta.title}</span>
        {meta.scheduleId ? (
          <Button size="sm" variant="ghost" onClick={() => openSchedule(meta.scheduleId!)}>
            {t('schedules.proposal.open', 'Open')}
          </Button>
        ) : null}
      </div>
    );
  }
  if (meta.outcome === 'dismissed') {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-xs text-muted-foreground">
        <CalendarClock className="size-3.5" />
        <span>{t('schedules.proposal.dismissed', 'Proposal ignored')}</span>
        <span className="min-w-0 flex-1 truncate line-through">{meta.title}</span>
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
  const reasons = problem ? [problemText[problem]] : blockers;
  const rows: [string, string][] = [
    [
      t('schedules.trigger.label', 'Trigger'),
      recurrence
        ? describeRecurrence(recurrence, t, i18n.language)
        : t('schedules.trigger.manual', 'Manual'),
    ],
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
    <div className="flex flex-col gap-2 rounded-md border border-border bg-card p-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <CalendarClock className="size-3.5" />
        <span>{t('schedules.proposal.title', 'Schedule this task?')}</span>
        {meta.proposedBy?.name ? (
          <span className="ml-auto truncate">
            {t('schedules.proposal.by', 'Proposed by {{name}}', { name: meta.proposedBy.name })}
          </span>
        ) : null}
      </div>
      <p className="text-sm font-medium">{meta.title}</p>
      <div className="max-h-40 overflow-y-auto rounded border border-border/60 p-2">
        <MarkdownRenderer text={meta.prompt} size="sm" />
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="truncate">{value}</dd>
          </div>
        ))}
      </dl>
      {reasons.length ? (
        <ul className="space-y-0.5 text-xs text-status-warning" aria-live="polite">
          {reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={busy} onClick={dismiss}>
          {t('schedules.proposal.dismiss', 'Ignore')}
        </Button>
        <Button size="sm" disabled={busy || reasons.length > 0 || !target} onClick={create}>
          {t('schedules.proposal.create', 'Create')}
        </Button>
      </div>
    </div>
  );
}

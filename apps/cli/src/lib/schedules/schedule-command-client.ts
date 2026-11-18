import { Effect } from 'effect';
import {
  SCHEDULE_CUSTOM_STEP_MAX,
  ScheduleProposalRuleSchema,
  ScheduleTriggerSchema,
  applyScheduleRecurrence,
  type ScheduleCommand,
  type ScheduleTrigger,
  type SessionId,
} from '@lody/shared';
import { makeLocalControlClientAuto } from '@lody/shared/node/local-ipc';
import { makeLocalWorkspaceCatalog } from '../local-workspace-catalog';
import {
  classifyLocalDaemonIpcError,
  getAuthContextOrThrow,
  resolveWorkspaceOrThrow,
  withWorkspaceManager,
} from '../command-runtime';
import { assertScheduleCommandAllowed, executeScheduleCommand } from './schedule-command-service';
import { LODY_AUTH_URL } from '@/utils/const';

/** Only Agent children carry this marker; human terminals also have LODY_SESSION_ID. */
export function scheduleRequesterSessionId(
  explicit?: SessionId,
  env: NodeJS.ProcessEnv = process.env
): SessionId | undefined {
  return explicit || (env.LODY_AGENT_SESSION_ID as SessionId | undefined) || undefined;
}

export async function sendScheduleCommand(
  command: ScheduleCommand,
  options: { workspace?: string; requesterSessionId?: SessionId } = {}
): Promise<unknown> {
  options = {
    ...options,
    requesterSessionId: scheduleRequesterSessionId(options.requesterSessionId),
  };
  assertScheduleCommandAllowed(command, options.requesterSessionId);
  if (LODY_AUTH_URL) {
    const auth = getAuthContextOrThrow('schedule');
    const workspace = await resolveWorkspaceOrThrow(auth, options.workspace);
    return withWorkspaceManager(auth, workspace, 'schedule', (manager) =>
      executeScheduleCommand(
        {
          manager,
          auth,
          workspace,
          localOnly: false,
          requesterSessionId: options.requesterSessionId,
        },
        command
      )
    );
  }
  const catalog = await Effect.runPromise(makeLocalWorkspaceCatalog().read());
  const selector = options.workspace ?? process.env.LODY_WORKSPACE_ID;
  const candidates = catalog.workspaces.filter(
    (row) =>
      row.state === 'active' &&
      (!selector || [row.workspaceId, row.slug, row.name].includes(selector))
  );
  if (candidates.length !== 1 || !catalog.machine)
    throw new Error(
      'Choose an active local workspace with --workspace; start the local daemon first'
    );
  return sendDaemonScheduleCommand(command, {
    machineId: catalog.machine.machineId,
    workspaceId: candidates[0]!.workspaceId,
    requesterSessionId: options.requesterSessionId,
  });
}

/** Execute against the running daemon's workspace replica, in any composition. */
export async function sendDaemonScheduleCommand(
  command: ScheduleCommand,
  target: {
    machineId: string;
    workspaceId: string;
    requesterSessionId?: SessionId;
    socketPath?: string;
  }
): Promise<unknown> {
  target = { ...target, requesterSessionId: scheduleRequesterSessionId(target.requesterSessionId) };
  assertScheduleCommandAllowed(command, target.requesterSessionId);
  const response = await Effect.runPromise(
    makeLocalControlClientAuto({ socketPath: target.socketPath })
      .scheduleControl({
        machineId: target.machineId,
        workspaceId: target.workspaceId,
        command,
        requesterSessionId: target.requesterSessionId,
      })
      .pipe(Effect.result)
  );
  if (response._tag === 'Failure') throw classifyLocalDaemonIpcError(response.failure);
  if (!response.success.ok) throw new Error(response.success.error);
  return response.success.result;
}

export type ScheduleEveryStep = { kind: 'minutes' | 'hours'; every: number };

/**
 * `--every 90m` / `--every 5h`. Bounds are the editor's Custom field and the
 * agent proposal rule (`ScheduleProposalRuleSchema`), so every surface accepts
 * the same steps.
 */
export function parseScheduleEvery(value: string): ScheduleEveryStep {
  const match = /^(\d{1,10})\s*(m|mins?|minutes?|h|hrs?|hours?)$/i.exec(value.trim());
  const rule = match
    ? ScheduleProposalRuleSchema.safeParse({
        kind: match[2]!.toLowerCase().startsWith('m') ? 'minutes' : 'hours',
        every: Number(match[1]),
      })
    : undefined;
  if (!rule?.success || (rule.data.kind !== 'minutes' && rule.data.kind !== 'hours'))
    throw new Error(
      `--every takes a whole number of minutes or hours from 1 to ${SCHEDULE_CUSTOM_STEP_MAX}, for example 90m or 5h`
    );
  return { kind: rule.data.kind, every: rule.data.every };
}

/**
 * The trigger `--every` means, exactly as the schedule editor stores it: a step
 * that divides the hour/day is clock-aligned cron in `timeZone`, any other step
 * an interval anchored at `now`. An edit that keeps the same step returns the
 * stored trigger unchanged, so its anchor and fingerprint survive.
 */
export function scheduleEveryTrigger(
  step: ScheduleEveryStep,
  options: { timeZone: string; now: number; previous?: ScheduleTrigger }
): ScheduleTrigger {
  try {
    new Intl.DateTimeFormat('en', { timeZone: options.timeZone });
  } catch {
    throw new Error(`Unknown time zone: ${options.timeZone}`);
  }
  return applyScheduleRecurrence(
    { ...step, timeZone: options.timeZone },
    options.now,
    options.previous
  );
}

/** The stored trigger from a `show` result, when it parses. */
export function scheduleShowTrigger(result: unknown): ScheduleTrigger | undefined {
  const trigger = (result as { schedule?: { definition?: { trigger?: unknown } } } | null)?.schedule
    ?.definition?.trigger;
  const parsed = ScheduleTriggerSchema.safeParse(trigger);
  return parsed.success ? parsed.data : undefined;
}

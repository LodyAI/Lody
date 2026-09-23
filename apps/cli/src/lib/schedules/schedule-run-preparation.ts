import {
  scheduleOwnSessionId,
  type AgentConfigMeta,
  type LocalProjectId,
  type MachineMeta,
  type ProjectRef,
  type ScheduleDestination,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';

import { buildProjectOptions } from './schedule-project-options';

/**
 * The two decisions that turn a Schedule definition into one Session's inputs:
 * which selectors describe its workspace, and which target owns it.
 *
 * They are pure and separate from `schedule-workspace.ts` because this is where
 * "no project" has to hold: a chat-only schedule must reach `prepareSessionInput`
 * with no repository, local project, branch or worktree selector at all, and
 * with no `project` on the target — not with a default filled in behind it.
 */
export type ScheduleRunIdentity = {
  sessionId: SessionId;
  userTurnId: string;
  agentConfigId: string;
  title: string;
  project?: ProjectRef;
};

export function buildScheduleSessionCreateOptions(
  run: ScheduleRunIdentity
): Record<string, unknown> {
  return {
    agentConfig: run.agentConfigId,
    sessionId: run.sessionId,
    userTurnId: run.userTurnId,
    title: run.title,
    // The Schedule engine has already refreshed workspace meta for this run.
    workspaceMetaPrewriteSatisfied: true,
    ...buildProjectOptions(run.project),
  };
}

export function buildScheduleRunTarget(target: {
  targetMachine: MachineMeta;
  agentConfig: AgentConfigMeta;
  project?: ProjectRef;
}): { targetMachine: MachineMeta; agentConfig: AgentConfigMeta; project?: ProjectRef } {
  return {
    targetMachine: target.targetMachine,
    agentConfig: target.agentConfig,
    ...(target.project ? { project: target.project } : {}),
  };
}

/**
 * The local project id a run requires on its owning machine before handoff, or
 * `undefined` when there is nothing to look up.
 */
export function scheduleRequiredLocalProjectId(
  project: ProjectRef | undefined
): LocalProjectId | undefined {
  return project?.kind === 'local' ? project.localProjectId : undefined;
}

/** The chat a destination sends into, or `undefined` for a fresh chat per run. */
export function scheduleDestinationSessionId(
  scheduleId: string,
  destination: ScheduleDestination
): SessionId | undefined {
  if (destination.kind === 'own_session')
    return scheduleOwnSessionId(scheduleId, destination.epoch);
  if (destination.kind === 'existing_session') return destination.sessionId as SessionId;
  return undefined;
}

export type DestinationSessionState =
  | { kind: 'absent' }
  | { kind: 'deleted' }
  | { kind: 'present'; meta: SessionMeta };

/**
 * Why a shared chat cannot take this schedule's runs, or `null` when it can.
 *
 * A chat the person picked must exist; a chat the schedule owns may not exist
 * yet (it is created by the first run). Either way, once it exists it must be
 * this owner's, on this machine, driven by this schedule's Agent — those are
 * exactly the fields `materializePreparedSessionInput` refuses to change, so
 * checking them here turns a late identity conflict into a named, recoverable
 * configuration problem.
 */
export function destinationSessionProblem(args: {
  destination: ScheduleDestination;
  session: DestinationSessionState;
  userId: string;
  machineId: string;
  agentConfigId: string;
}): 'SESSION_UNAVAILABLE' | null {
  const { destination, session } = args;
  if (destination.kind === 'new_session') return null;
  if (session.kind === 'deleted') return 'SESSION_UNAVAILABLE';
  if (session.kind === 'absent')
    return destination.kind === 'existing_session' ? 'SESSION_UNAVAILABLE' : null;
  const meta = session.meta;
  return meta.userId === args.userId &&
    meta.machineId === args.machineId &&
    meta.agentConfigId === args.agentConfigId
    ? null
    : 'SESSION_UNAVAILABLE';
}

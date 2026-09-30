import { describe, expect, it } from 'vitest';
import type {
  AgentConfigMeta,
  MachineMeta,
  ProjectRef,
  SessionId,
  SessionMeta,
} from '@lody/shared';

import {
  buildScheduleRunTarget,
  buildScheduleSessionCreateOptions,
  destinationSessionProblem,
  scheduleDestinationSessionId,
  scheduleRequiredLocalProjectId,
} from './schedule-run-preparation';

const run = (project?: ProjectRef) => ({
  sessionId: 'session' as SessionId,
  userTurnId: 'turn',
  agentConfigId: 'agent',
  title: 'Daily review',
  project,
});

/** Every selector that can put a run in a working directory. */
const WORKSPACE_SELECTORS = ['repo', 'branch', 'localProject', 'worktree'] as const;

const machine = { id: 'machine', ownerUserId: 'owner' } as unknown as MachineMeta;
const agentConfig = { id: 'agent', machineId: 'machine' } as unknown as AgentConfigMeta;

describe('Session inputs for one scheduled run', () => {
  it('carries a GitHub project onto the create selectors', () => {
    expect(
      buildScheduleSessionCreateOptions(
        run({ kind: 'github', repoFullName: 'loro-dev/lody', branch: 'main' })
      )
    ).toMatchObject({ repo: 'loro-dev/lody', branch: 'main' });
  });

  it('carries a local project and its worktree choice', () => {
    expect(
      buildScheduleSessionCreateOptions(
        run({ kind: 'local', localProjectId: 'p1' as never, useWorktree: true })
      )
    ).toMatchObject({ localProject: 'p1', worktree: true });
    expect(
      buildScheduleSessionCreateOptions(
        run({ kind: 'local', localProjectId: 'p1' as never, useWorktree: false })
      )
    ).not.toHaveProperty('worktree');
  });

  it('sends no workspace selector at all for a chat-only run', () => {
    const options = buildScheduleSessionCreateOptions(run());
    for (const selector of WORKSPACE_SELECTORS) expect(options).not.toHaveProperty(selector);
    // The rest of the run identity is still there, so this is "no project",
    // not "no options".
    expect(options).toEqual({
      agentConfig: 'agent',
      sessionId: 'session',
      userTurnId: 'turn',
      title: 'Daily review',
      workspaceMetaPrewriteSatisfied: true,
    });
  });

  it('freezes the identity the engine planned, not a fresh one', () => {
    expect(buildScheduleSessionCreateOptions(run())).toMatchObject({
      sessionId: 'session',
      userTurnId: 'turn',
      agentConfig: 'agent',
    });
  });
});

describe('Target for one scheduled run', () => {
  it('omits the project key entirely for a chat-only run', () => {
    const target = buildScheduleRunTarget({ targetMachine: machine, agentConfig });
    expect(Object.keys(target).sort()).toEqual(['agentConfig', 'targetMachine']);
    expect('project' in target).toBe(false);
  });

  it('passes a chosen project through unchanged', () => {
    const project: ProjectRef = { kind: 'github', repoFullName: 'loro-dev/lody', branch: 'main' };
    expect(buildScheduleRunTarget({ targetMachine: machine, agentConfig, project })).toEqual({
      targetMachine: machine,
      agentConfig,
      project,
    });
  });
});

describe('What a run requires from the owning machine', () => {
  it('asks for a local project ledger entry only when one was chosen', () => {
    expect(scheduleRequiredLocalProjectId(undefined)).toBeUndefined();
    expect(
      scheduleRequiredLocalProjectId({
        kind: 'github',
        repoFullName: 'loro-dev/lody',
        branch: 'main',
      })
    ).toBeUndefined();
    expect(scheduleRequiredLocalProjectId({ kind: 'local', localProjectId: 'p1' as never })).toBe(
      'p1'
    );
  });
});

describe('Where a run is sent', () => {
  const machineId = 'machine';
  const meta = (overrides: Partial<SessionMeta> = {}) =>
    ({
      id: 's1',
      userId: 'owner',
      machineId,
      agentConfigId: 'agent',
      ...overrides,
    }) as SessionMeta;

  it('names the same chat for every run of an owned-chat schedule, and a new one per epoch', () => {
    const own = { kind: 'own_session', epoch: 0 } as const;
    expect(scheduleDestinationSessionId('sched', own)).toBe(
      scheduleDestinationSessionId('sched', own)
    );
    expect(scheduleDestinationSessionId('sched', { kind: 'own_session', epoch: 1 })).not.toBe(
      scheduleDestinationSessionId('sched', own)
    );
    expect(scheduleDestinationSessionId('other', own)).not.toBe(
      scheduleDestinationSessionId('sched', own)
    );
    expect(scheduleDestinationSessionId('sched', { kind: 'new_session' })).toBeUndefined();
    expect(
      scheduleDestinationSessionId('sched', { kind: 'existing_session', sessionId: 'picked' })
    ).toBe('picked');
  });

  it('lets an owned chat be created by the first run, but never a picked chat', () => {
    const base = { userId: 'owner', machineId, agentConfigId: 'agent' };
    expect(
      destinationSessionProblem({
        ...base,
        destination: { kind: 'own_session', epoch: 0 },
        session: { kind: 'absent' },
      })
    ).toBeNull();
    expect(
      destinationSessionProblem({
        ...base,
        destination: { kind: 'existing_session', sessionId: 's1' },
        session: { kind: 'absent' },
      })
    ).toBe('SESSION_UNAVAILABLE');
  });

  it('refuses a chat that is deleted, someone else’s, elsewhere, or driven by another Agent', () => {
    const base = { userId: 'owner', machineId, agentConfigId: 'agent' };
    const destination = { kind: 'existing_session', sessionId: 's1' } as const;
    expect(
      destinationSessionProblem({
        ...base,
        destination,
        session: { kind: 'present', meta: meta() },
      })
    ).toBeNull();
    expect(destinationSessionProblem({ ...base, destination, session: { kind: 'deleted' } })).toBe(
      'SESSION_UNAVAILABLE'
    );
    for (const wrong of [{ userId: 'other' }, { machineId: 'laptop' }, { agentConfigId: 'writer' }])
      expect(
        destinationSessionProblem({
          ...base,
          destination,
          session: { kind: 'present', meta: meta(wrong) },
        })
      ).toBe('SESSION_UNAVAILABLE');
  });
});

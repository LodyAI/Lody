import { describe, expect, it } from 'vitest';
import type {
  AgentConfigMeta,
  MachineMeta,
  ProjectRef,
  SessionId,
  SessionMeta,
} from '@lody/shared';

import { destinationSessionProblem } from './schedule-run-preparation';

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

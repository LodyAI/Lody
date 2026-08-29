import { describe, expect, it } from 'vitest';
import {
  SessionStatusFactory,
  type LocalProjectId,
  type MachineId,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import { getRemoveLocalProjectImpactFromSessions } from '../src/hooks/use-remove-local-project';

const machineId = 'machine-a' as MachineId;
const localProjectId = 'project-a' as LocalProjectId;

function localSession(
  id: string,
  status: SessionMeta['status'],
  overrides: Partial<SessionMeta> = {}
): SessionMeta {
  return {
    id: id as SessionId,
    machineId,
    createdAt: '2026-08-28T00:00:00.000Z',
    status,
    project: { kind: 'local', localProjectId },
    ...overrides,
  } as SessionMeta;
}

describe('getRemoveLocalProjectImpactFromSessions', () => {
  it('counts every matching conversation and only active ones as running', () => {
    const sessions = [
      localSession('running', SessionStatusFactory.running()),
      localSession('initializing', SessionStatusFactory.initializing()),
      localSession('idle', SessionStatusFactory.idle()),
      localSession('other-project', SessionStatusFactory.running(), {
        project: { kind: 'local', localProjectId: 'project-b' as LocalProjectId },
      }),
      localSession('other-machine', SessionStatusFactory.running(), {
        machineId: 'machine-b' as MachineId,
      }),
    ];

    expect(
      getRemoveLocalProjectImpactFromSessions(sessions, { machineId, localProjectId })
    ).toEqual({
      conversationCount: 3,
      runningSessionCount: 2,
    });
  });
});

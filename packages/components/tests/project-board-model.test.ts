import { describe, expect, it } from 'vitest';
import type { MachineId, SessionMeta, SessionStatus } from '@lody/shared';
import {
  buildProjectBoard,
  findProjectCoordinatorSession,
  type CoordinatorProjectKey,
} from '../src/components/project-mode/project-board-model';
import { buildChildSessionsByParent } from '../src/components/sessions/session-list-rows';

const machineId = 'machine-1' as MachineId;
const project: CoordinatorProjectKey = { kind: 'local', machineId, localProjectId: 'proj-a' };

const session = (id: string, overrides: Partial<SessionMeta> = {}): SessionMeta =>
  ({
    id,
    machineId,
    userId: 'user-1',
    createdAt: '2026-11-12T00:00:00.000Z',
    cliType: 'builtin',
    agentType: 'claude',
    project: { kind: 'local', localProjectId: 'proj-a' },
    ...overrides,
  }) as SessionMeta;

const coordinator = session('coordinator', { coordinator: { version: 1 }, lastMessageAt: 10 });

function board(sessions: SessionMeta[], live: Record<string, SessionStatus> = {}) {
  return buildProjectBoard({
    sessions,
    childSessionsByParent: buildChildSessionsByParent(sessions),
    project,
    coordinatorSessionId: coordinator.id,
    liveSessionStatuses: new Map(Object.entries(live)),
    sendStates: {},
  });
}

const ids = (rows: { session: SessionMeta }[]) => rows.map((row) => row.session.id);

describe('project board', () => {
  it('buckets each conversation by what it needs from the user', () => {
    const result = board(
      [
        coordinator,
        session('asks', { openedBySessionId: coordinator.id as never, awaitingUserSince: 5 }),
        session('permission', { openedBySessionId: coordinator.id as never }),
        session('running', { openedBySessionId: coordinator.id as never }),
        session('finished', {
          openedBySessionId: coordinator.id as never,
          lastMessageAt: 20,
          lastReadAt: 10,
        }),
        session('read', {
          openedBySessionId: coordinator.id as never,
          lastMessageAt: 5,
          lastReadAt: 9,
        }),
      ],
      { permission: { type: 'requestPermission' }, running: { type: 'running' } }
    );

    expect(ids(result.needsYou).sort()).toEqual(['asks', 'permission']);
    expect(ids(result.working)).toEqual(['running']);
    expect(ids(result.unread)).toEqual(['finished']);
    expect(ids(result.done)).toEqual(['read']);
  });

  it('includes conversations the coordinator opened elsewhere and marks the project’s own as manual', () => {
    const result = board([
      coordinator,
      session('dispatched-elsewhere', {
        openedBySessionId: coordinator.id as never,
        project: { kind: 'github', repoFullName: 'acme/other' },
      }),
      session('manual'),
      session('other-project', { project: { kind: 'local', localProjectId: 'proj-b' } }),
      session('archived', { isArchived: true }),
      session('tab', { parentSessionId: 'manual' as never }),
      session('second-coordinator', { coordinator: { version: 1 } }),
    ]);
    const rows = [...result.needsYou, ...result.working, ...result.unread, ...result.done];

    expect(ids(rows).sort()).toEqual(['dispatched-elsewhere', 'manual']);
    expect(rows.find((row) => row.session.id === 'manual')?.createdManually).toBe(true);
    expect(rows.find((row) => row.session.id === 'dispatched-elsewhere')?.createdManually).toBe(
      false
    );
  });

  it('opens the user’s most recent coordinator of the project', () => {
    const older = session('older', { coordinator: { version: 1 }, lastMessageAt: 1 });
    const theirs = session('theirs', {
      coordinator: { version: 1 },
      lastMessageAt: 99,
      userId: 'user-2',
    });
    const archived = session('archived', {
      coordinator: { version: 1 },
      lastMessageAt: 50,
      isArchived: true,
    });
    const sessions = [
      older,
      coordinator,
      theirs,
      archived,
      session('plain', { lastMessageAt: 80 }),
    ];

    expect(findProjectCoordinatorSession(sessions, project, 'user-1')?.id).toBe('coordinator');
    expect(
      findProjectCoordinatorSession(sessions, { kind: 'github', repoFullName: 'acme/x' }, 'user-1')
    ).toBeNull();
  });
});

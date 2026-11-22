import { describe, expect, it } from 'vitest';
import type { MachineId, SessionMeta, SessionStatus } from '@lody/shared';
import {
  buildProjectBoard,
  coordinatorProjectKeyId,
  findProjectCoordinatorSession,
  isSessionInCoordinatorProject,
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

function board(
  sessions: SessionMeta[],
  live: Record<string, SessionStatus> = {},
  currentUserId: string | null = 'user-1'
) {
  return buildProjectBoard({
    sessions,
    childSessionsByParent: buildChildSessionsByParent(sessions),
    project,
    coordinatorSessionId: coordinator.id,
    currentUserId,
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
        session('accepted', {
          openedBySessionId: coordinator.id as never,
          lastMessageAt: 5,
          lastReadAt: 9,
          coordinatorTaskAcceptedAt: 6,
        }),
        session('reopened', {
          openedBySessionId: coordinator.id as never,
          lastMessageAt: 30,
          lastReadAt: 30,
          coordinatorTaskAcceptedAt: 25,
        }),
      ],
      { permission: { type: 'requestPermission' }, running: { type: 'running' } }
    );

    expect(ids(result.needsYou).sort()).toEqual(['asks', 'permission']);
    expect(ids(result.working)).toEqual(['running']);
    expect(ids(result.review)).toEqual(['reopened', 'finished']);
    expect(ids(result.accepted)).toEqual(['accepted']);
  });

  it('numbers the coordinator’s tasks by creation, stable across archiving and manual work', () => {
    const created = (minute: number) => `2026-11-12T00:${String(minute).padStart(2, '0')}:00.000Z`;
    const result = board([
      coordinator,
      session('second', { openedBySessionId: coordinator.id as never, createdAt: created(2) }),
      session('first-archived', {
        openedBySessionId: coordinator.id as never,
        createdAt: created(1),
        isArchived: true,
      }),
      session('third', { openedBySessionId: coordinator.id as never, createdAt: created(3) }),
      session('manual', { createdAt: created(0) }),
    ]);
    const rows = Object.values(result).flat();
    const numberOf = (id: string) => rows.find((row) => row.session.id === id)?.taskNumber;

    expect(numberOf('second')).toBe(2);
    expect(numberOf('third')).toBe(3);
    expect(numberOf('manual')).toBeUndefined();

    const acceptedArchived = board([
      coordinator,
      session('accepted-archived', {
        title: 'Streams presence 桌面前台通知',
        openedBySessionId: coordinator.id as never,
        createdAt: created(1),
        coordinatorTaskAcceptedAt: 20,
        isArchived: true,
      }),
    ]);
    expect(acceptedArchived.accepted).toHaveLength(1);
    expect(acceptedArchived.accepted[0]?.session.title).toBe('Streams presence 桌面前台通知');
    expect(acceptedArchived.accepted[0]?.taskNumber).toBe(1);

    const withPr = board([
      coordinator,
      session('pr-task', {
        openedBySessionId: coordinator.id as never,
        pullRequests: [{ url: 'https://github.com/LodyAI/lody/pull/2631', status: 'open' }],
        pullRequestState: {
          'https://github.com/LodyAI/lody/pull/2631': { s: 's', m: 'c', t: 1 },
        },
      }),
    ]);
    expect(withPr.review[0]?.pullRequest).toMatchObject({
      repoFullName: 'LodyAI/lody',
      number: 2631,
      status: 'open',
      ci: 's',
      readiness: 'y',
    });

    const allSessions = [
      coordinator,
      session('first-archived', {
        title: 'Streams presence 桌面前台通知',
        openedBySessionId: coordinator.id as never,
        createdAt: created(1),
        coordinatorTaskAcceptedAt: 20,
        isArchived: true,
      }),
      session('second', { openedBySessionId: coordinator.id as never, createdAt: created(2) }),
    ];
    const withArchived = buildProjectBoard({
      sessions: allSessions,
      childSessionsByParent: buildChildSessionsByParent(allSessions),
      project,
      coordinatorSessionId: coordinator.id,
      currentUserId: 'user-1',
      liveSessionStatuses: new Map(),
      sendStates: {},
      includeArchived: true,
    });
    expect(withArchived.accepted).toHaveLength(1);
    expect(withArchived.accepted[0]?.session.title).toBe('Streams presence 桌面前台通知');
    expect(withArchived.accepted[0]?.taskNumber).toBe(1);
    expect(withArchived.accepted[0]?.bucket).toBe('accepted');
  });

  it('lists only the coordinator’s own tasks, wherever they run', () => {
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
      session('teammate', { userId: 'user-2' }),
      session('teammate-dispatched', {
        userId: 'user-2',
        openedBySessionId: coordinator.id as never,
      }),
    ]);
    const rows = Object.values(result).flat();

    expect(ids(rows)).toEqual(['dispatched-elsewhere']);
  });

  it('lists nothing while the current account is unknown', () => {
    const result = board([coordinator, session('manual')], {}, null);

    expect(Object.values(result).flat()).toEqual([]);
  });

  it('binds the project to the newest coordinator the user created, regardless of activity', () => {
    const created = (minute: number) => `2026-11-12T00:${String(minute).padStart(2, '0')}:00.000Z`;
    const original = session('original', {
      coordinator: { version: 1 },
      createdAt: created(1),
      lastMessageAt: 999,
    });
    const replacement = session('replacement', {
      coordinator: { version: 1 },
      createdAt: created(5),
      lastMessageAt: 1,
    });
    const theirs = session('theirs', {
      coordinator: { version: 1 },
      createdAt: created(9),
      userId: 'user-2',
    });
    const archived = session('archived', {
      coordinator: { version: 1 },
      createdAt: created(8),
      isArchived: true,
    });
    const plain = session('plain', { createdAt: created(7) });

    expect(
      findProjectCoordinatorSession(
        [original, replacement, theirs, archived, plain],
        project,
        'user-1'
      )?.id
    ).toBe('replacement');
    expect(findProjectCoordinatorSession([original, theirs], project, 'user-1')?.id).toBe(
      'original'
    );
    expect(
      findProjectCoordinatorSession(
        [original],
        { kind: 'github', repoFullName: 'acme/x' },
        'user-1'
      )
    ).toBeNull();
    expect(findProjectCoordinatorSession([original], project, null)).toBeNull();
  });

  it('treats GitHub repository casing variants as one coordinator project', () => {
    const upperKey: CoordinatorProjectKey = { kind: 'github', repoFullName: 'LodyAI/Lody' };
    const lowerKey: CoordinatorProjectKey = { kind: 'github', repoFullName: 'LodyAI/lody' };
    expect(coordinatorProjectKeyId(upperKey)).toBe('github:lodyai/lody');
    expect(coordinatorProjectKeyId(lowerKey)).toBe('github:lodyai/lody');

    const olderLowerCoordinator = session('coord-lower', {
      coordinator: { version: 1 },
      createdAt: '2026-11-10T00:00:00.000Z',
      project: { kind: 'github', repoFullName: 'LodyAI/lody', branch: 'main' },
      repoFullName: 'LodyAI/lody',
    });
    const newerUpperCoordinator = session('coord-upper', {
      coordinator: { version: 1 },
      createdAt: '2026-11-22T00:00:00.000Z',
      project: { kind: 'github', repoFullName: 'LodyAI/Lody', branch: 'main' },
      repoFullName: 'LodyAI/Lody',
    });

    expect(isSessionInCoordinatorProject(olderLowerCoordinator, upperKey)).toBe(true);
    expect(isSessionInCoordinatorProject(newerUpperCoordinator, lowerKey)).toBe(true);
    expect(
      findProjectCoordinatorSession(
        [olderLowerCoordinator, newerUpperCoordinator],
        lowerKey,
        'user-1'
      )?.id
    ).toBe('coord-upper');
  });
});

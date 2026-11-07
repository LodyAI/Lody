import {
  getEffectiveSessionActivitySummary as getTaskActivitySummary,
  mapSessionMetaToTaskListTask,
} from '../src/components/sessions/session-tasklist-mapping';
import { getSessionGitHubState } from '../src/lib/session-github-state';
import { describe, expect, test } from 'vitest';

import type { MachineId, SessionId, SessionMeta, SessionStatus } from '@lody/shared';

import {
  buildChildSessionsByParent,
  buildSessionListRows,
  selectSidebarTaskSessions,
  getEffectiveSessionActivitySummary,
} from '../src/components/sessions/session-list-rows';

const machineId = 'machine-1' as MachineId;

test('shows unavailable encrypted local-project history as a chat without adding a project or changing ordinary lists', () => {
  const chat = makeSession({ id: 'chat' });
  const project = makeSession({
    id: 'project-history',
    project: { kind: 'local', localProjectId: 'private-project' as never },
  });
  const projects = new Map();
  const rows = buildSessionListRows(selectSidebarTaskSessions([chat, project], projects, true), {
    scope: 'team',
    currentUserId: 'new-member',
    defaultTitle: 'History',
  });
  expect(rows.map((row) => row.sessionId)).toEqual(['chat', 'project-history']);
  expect(projects.size).toBe(0);
  expect(selectSidebarTaskSessions([chat, project], projects)).toEqual([chat]);
  projects.set(`${machineId}:private-project`, {});
  expect(selectSidebarTaskSessions([chat, project], projects, true)).toEqual([chat]);
});

function makeSession(overrides: Partial<SessionMeta> & { id: string }): SessionMeta {
  return {
    id: overrides.id as SessionId,
    machineId,
    createdAt: '2026-05-09T10:00:00.000Z',
    userId: 'user-1',
    cliType: 'builtin',
    agentType: 'codex',
    ...overrides,
  } as SessionMeta;
}

test('names a sidebar row by its group title, independent of the root tab title', () => {
  const rows = buildSessionListRows(
    [
      makeSession({ id: 'named', title: 'Root tab', groupTitle: 'Group name' }),
      makeSession({ id: 'legacy', title: 'Root tab only' }),
    ],
    { scope: 'team', currentUserId: 'user-1', defaultTitle: 'Untitled' }
  );
  expect(Object.fromEntries(rows.map((row) => [row.sessionId, row.title]))).toEqual({
    named: 'Group name',
    legacy: 'Root tab only',
  });
});

describe('buildSessionListRows child-time aggregation', () => {
  test("parent task's latestMessageAt reflects the most recent child activity", () => {
    const parent = makeSession({ id: 'parent', lastMessageAt: 1_000, title: 'Parent' });
    const child = makeSession({
      id: 'child',
      parentSessionId: 'parent' as SessionId,
      lastMessageAt: 4_000,
    });

    const tasks = buildSessionListRows(
      [parent],
      {
        scope: 'my',
        currentUserId: 'user-1',
        defaultTitle: 'Untitled',
      },
      [parent, child]
    );

    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.latestMessageAt).toBe(4_000);
  });

  test('parent task keeps its own time when newer than all children', () => {
    const parent = makeSession({ id: 'parent', lastMessageAt: 7_000, title: 'Parent' });
    const child = makeSession({
      id: 'child',
      parentSessionId: 'parent' as SessionId,
      lastMessageAt: 2_000,
    });

    const tasks = buildSessionListRows(
      [parent],
      {
        scope: 'my',
        currentUserId: 'user-1',
        defaultTitle: 'Untitled',
      },
      [parent, child]
    );

    expect(tasks[0]?.latestMessageAt).toBe(7_000);
  });

  test('does not treat durable running status as working without live presence', () => {
    const session = makeSession({
      id: 'session',
      title: 'Session',
      status: { type: 'running' },
      lastRunningSeen: Date.now(),
    });

    const tasks = buildSessionListRows([session], {
      scope: 'my',
      currentUserId: 'user-1',
      defaultTitle: 'Untitled',
    });

    expect(tasks[0]?.isWorking).toBe(false);
  });
});

describe('getEffectiveSessionActivitySummary child-status aggregation', () => {
  test('rolls child running, permission, unread, and latest message state into the parent', () => {
    const now = Date.now();
    const parent = makeSession({
      id: 'parent',
      status: { type: 'idle' },
      lastMessageAt: now - 10_000,
      lastReadAt: now,
    });
    const runningChild = makeSession({
      id: 'child-running',
      parentSessionId: parent.id,
      status: { type: 'idle' },
      lastMessageAt: now - 5_000,
      lastReadAt: now,
    });
    const permissionChild = makeSession({
      id: 'child-permission',
      parentSessionId: parent.id,
      status: { type: 'idle' },
      lastMessageAt: now - 2_000,
      lastReadAt: now - 3_000,
    });
    const map = buildChildSessionsByParent([parent, runningChild, permissionChild]);
    const liveSessionStatuses = new Map<string, SessionStatus>([
      [runningChild.id, { type: 'running' }],
      [permissionChild.id, { type: 'requestPermission' }],
    ]);

    const activity = getEffectiveSessionActivitySummary(parent, map, liveSessionStatuses);

    expect(activity).toMatchObject({
      isWorking: true,
      isWaitingPermission: true,
      hasUnreadMessages: true,
    });
    expect(activity.latestMessageAt).toBe(permissionChild.lastMessageAt);
  });

  test('ignores archived child status when building the child lookup', () => {
    const now = Date.now();
    const parent = makeSession({
      id: 'parent',
      status: { type: 'idle' },
      lastMessageAt: now - 10_000,
      lastReadAt: now,
    });
    const archivedChild = makeSession({
      id: 'archived-child',
      parentSessionId: parent.id,
      isArchived: true,
      status: { type: 'requestPermission' },
      lastRunningSeen: now,
      lastMessageAt: now,
    });
    const map = buildChildSessionsByParent([parent, archivedChild]);

    expect(getEffectiveSessionActivitySummary(parent, map)).toEqual({
      isWorking: false,
      isWaitingPermission: false,
      hasUnreadMessages: false,
      latestMessageAt: parent.lastMessageAt,
    });
  });
});

describe('buildSessionListRows repo + PR mapping', () => {
  test("shows a Project group's default-repository PR, matching the Info Bar", () => {
    const api = 'https://github.com/example/api/pull/7';
    const web = 'https://github.com/example/web/pull/9';
    const session = makeSession({
      id: 'session',
      title: 'Group session',
      project: { kind: 'github', repoFullName: 'example/api', branch: 'main' },
      projectRun: { name: 'group', members: {} } as unknown as SessionMeta['projectRun'],
      pullRequests: [
        { url: api, status: 'merged' },
        { url: web, status: 'open' },
      ],
      pullRequestState: { [web]: { s: 'f', t: 1 } },
    });

    const [row] = buildSessionListRows([session], {
      scope: 'my',
      currentUserId: 'user-1',
      defaultTitle: 'Untitled',
    });
    const task = mapSessionMetaToTaskListTask(session, 'Untitled');
    const infoBar = getSessionGitHubState(session);

    expect(infoBar.latestPr?.url).toBe(api);
    expect([row?.prUrl, row?.prStatus, row?.prCiState]).toEqual([api, 'merged', null]);
    expect([task.prUrl, task.prStatus, task.prCiState]).toEqual([api, 'merged', null]);
  });

  test('derives no readiness when the PR merge state is not clean', () => {
    const session = makeSession({
      id: 'session',
      title: 'PR session',
      project: { kind: 'github', repoFullName: 'loro-dev/lody', branch: 'main' },
      pullRequests: [{ url: 'https://github.com/loro-dev/lody/pull/42', status: 'open' }],
      pullRequestState: {
        'https://github.com/loro-dev/lody/pull/42': {
          s: 's',
          m: 'b',
          // Stale legacy readiness: must be ignored, never re-authorize merge.
          r: 'y',
          t: 1_752_000_000,
        },
      },
    });

    const tasks = buildSessionListRows([session], {
      scope: 'my',
      currentUserId: 'user-1',
      defaultTitle: 'Untitled',
    });

    expect(tasks[0]?.prReadiness).toBeNull();
  });
});

describe('buildSessionListRows opened-by provenance', () => {
  test('a parentSessionId child keeps its own child aggregation and is not confused with an opened session', () => {
    // The sidebar never receives child sessions (they are filtered upstream by
    // `sessionListAtom`), but a child that also carries `openedBySessionId`
    // must still roll up as a child rather than being re-parented by it.
    const parent = makeSession({ id: 'parent', lastMessageAt: 1_000 });
    const child = makeSession({
      id: 'child',
      parentSessionId: 'parent' as SessionId,
      openedBySessionId: 'parent' as SessionId,
      lastMessageAt: 5_000,
    });

    const rows = buildSessionListRows(
      [parent],
      { scope: 'my', currentUserId: 'user-1', defaultTitle: 'Untitled' },
      [parent, child]
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.sessionId).toBe('parent');
    expect(rows[0]?.latestMessageAt).toBe(5_000);
  });
});

describe.each([getEffectiveSessionActivitySummary, getTaskActivitySummary])(
  'closed conversation activity',
  (summarize) => {
    test('ignores closed output while retaining live status and open child unread', () => {
      const parent = makeSession({ id: 'parent', isTabClosed: true, lastMessageAt: 100 });
      const child = makeSession({
        id: 'child',
        parentSessionId: parent.id,
        isTabClosed: true,
        lastMessageAt: 200,
      });
      const children = new Map([[parent.id, [child]]]);
      const presence = new Map<string, SessionStatus>([[child.id, { type: 'requestPermission' }]]);
      expect(summarize(parent, children, presence)).toMatchObject({
        hasUnreadMessages: false,
        isWorking: true,
        isWaitingPermission: true,
        latestMessageAt: 200,
      });
      child.isTabClosed = false;
      expect(summarize(parent, children, presence).hasUnreadMessages).toBe(true);
      child.lastReadAt = 200;
      expect(summarize(parent, children, presence).hasUnreadMessages).toBe(false);
    });
  }
);

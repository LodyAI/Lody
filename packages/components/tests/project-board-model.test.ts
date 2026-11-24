import { describe, expect, it } from 'vitest';
import type {
  MachineId,
  SessionCoordinatorDiagnosticsResponse,
  SessionHistoryParsed,
  SessionId,
  SessionMeta,
  SessionStatus,
  WorkspaceId,
} from '@lody/shared';
import { buildCoordinatorObservabilitySnapshot } from '../src/components/project-mode/coordinator-observability-model';
import {
  buildProjectBoard,
  coordinatorProjectKeyId,
  findProjectCoordinatorSession,
  hasMultiplePullRequestRepos,
  isSessionInCoordinatorProject,
  resolveOwnerSessionForPullRequest,
  summarizeProjectBoardPullRequests,
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

  it('groups collaborating child sessions under one WorkItem while preserving T<n> numbering and multi-repo PRs', () => {
    const created = (minute: number) => `2026-11-12T00:${String(minute).padStart(2, '0')}:00.000Z`;
    const soloFirst = session('solo-first', {
      openedBySessionId: coordinator.id as never,
      createdAt: created(1),
      lastMessageAt: 10,
      lastReadAt: 5,
    });
    const implLead = session('impl-lead', {
      title: 'Implement ACP token refresh',
      openedBySessionId: coordinator.id as never,
      createdAt: created(2),
      lastMessageAt: 20,
      lastReadAt: 20,
      workItemId: 'impl-lead',
      workItemRole: 'implement',
      pullRequests: [
        { url: 'https://github.com/LodyAI/acp-extension-pi/pull/18', status: 'open' },
        { url: 'https://github.com/LodyAI/lody/pull/2701', status: 'draft' },
      ],
      pullRequestState: {
        'https://github.com/LodyAI/acp-extension-pi/pull/18': { s: 's', m: 'c', t: 1 },
      },
    });
    const reviewPartner = session('review-partner', {
      title: 'Independent security review',
      openedBySessionId: coordinator.id as never,
      createdAt: created(5),
      lastMessageAt: 35,
      lastReadAt: 10,
      workItemId: 'impl-lead',
      workItemRole: 'review',
      pullRequests: [
        { url: 'https://github.com/LodyAI/acp-extension-pi/pull/18', status: 'open' },
        { url: 'https://github.com/LodyAI/lody/pull/2702', status: 'merged' },
      ],
    });
    const soloThird = session('solo-third', {
      openedBySessionId: coordinator.id as never,
      createdAt: created(3),
      lastMessageAt: 15,
      lastReadAt: 5,
    });

    const allSessions = [coordinator, soloFirst, implLead, soloThird, reviewPartner];
    const result = buildProjectBoard({
      sessions: allSessions,
      childSessionsByParent: buildChildSessionsByParent(allSessions),
      project,
      coordinatorSessionId: coordinator.id,
      currentUserId: 'user-1',
      liveSessionStatuses: new Map([['review-partner', { type: 'running' }]]),
      sendStates: {},
      workItems: {
        'impl-lead': {
          id: 'impl-lead',
          title: 'ACP submodule token refresh',
          mode: 'direct',
          externalRefs: [
            {
              kind: 'linear_issue',
              label: 'ENG-204',
              uri: 'https://linear.app/lody/issue/ENG-204',
            },
          ],
          createdAt: 100,
          updatedAt: 200,
        },
      },
    });

    const rows = Object.values(result).flat();
    expect(rows).toHaveLength(3);

    const byWorkItem = new Map(rows.map((row) => [row.workItemId, row]));
    expect(byWorkItem.get('solo-first')?.taskNumber).toBe(1);
    expect(byWorkItem.get('impl-lead')?.taskNumber).toBe(2);
    expect(byWorkItem.get('solo-third')?.taskNumber).toBe(3);

    const grouped = byWorkItem.get('impl-lead')!;
    expect(grouped.bucket).toBe('working');
    expect(grouped.workItemTitle).toBe('ACP submodule token refresh');
    expect(grouped.collaborationMode).toBe('direct');
    expect(grouped.externalRefs).toEqual([
      {
        kind: 'linear_issue',
        label: 'ENG-204',
        uri: 'https://linear.app/lody/issue/ENG-204',
      },
    ]);
    expect(
      grouped.members.map((m) => ({ id: m.session.id, role: m.role, bucket: m.bucket }))
    ).toEqual([
      { id: 'impl-lead', role: 'implement', bucket: 'review' },
      { id: 'review-partner', role: 'review', bucket: 'working' },
    ]);
    expect(grouped.pullRequests.map((pr) => `${pr.repoFullName}#${pr.number}`)).toEqual([
      'LodyAI/lody#2701',
      'LodyAI/acp-extension-pi#18',
      'LodyAI/lody#2702',
    ]);
    expect(hasMultiplePullRequestRepos(grouped.pullRequests)).toBe(true);
    expect(
      resolveOwnerSessionForPullRequest(grouped, 'https://github.com/LodyAI/lody/pull/2701')
    ).toBe('impl-lead');
    expect(
      resolveOwnerSessionForPullRequest(grouped, 'https://github.com/LodyAI/lody/pull/2702')
    ).toBe('review-partner');
  });

  it('builds a full coordinator observability snapshot across blackboard, causal cards, cursors, and Wake Gate', () => {
    const nowMs = 100_000;
    const directLead = session('direct-lead', {
      openedBySessionId: coordinator.id as SessionId,
      workItemId: 'direct-lead',
      workItemRole: 'implement',
      title: 'Direct UI Co-Design',
      createdAt: '2026-11-12T00:01:00.000Z',
      lastMessageAt: nowMs - 10_000,
      latestUserMsgId: 'child-turn-2',
      pullRequests: [
        {
          url: 'https://github.com/LodyAI/lody/pull/2801',
          repoFullName: 'LodyAI/lody',
          number: 2801,
          status: 'open',
          state: { s: 'pass', m: 'clean' },
        },
      ],
    });
    const delegatedWorker = session('delegated-worker', {
      openedBySessionId: coordinator.id as SessionId,
      workItemId: 'delegated-worker',
      workItemRole: 'verify',
      title: 'Run Integration Suite',
      createdAt: '2026-11-12T00:02:00.000Z',
      lastMessageAt: nowMs - 20_000,
      latestUserMsgId: 'worker-turn-1',
    });

    const rawWorkItems = {
      'direct-lead': {
        id: 'direct-lead',
        title: 'Split-pane co-design',
        mode: 'direct',
        createdAt: 1_000,
        updatedAt: 5_000,
      },
    };
    const allSessions = [coordinator, directLead, delegatedWorker];
    const boardResult = buildProjectBoard({
      sessions: allSessions,
      childSessionsByParent: buildChildSessionsByParent(allSessions),
      project,
      coordinatorSessionId: coordinator.id,
      currentUserId: 'user-1',
      liveSessionStatuses: new Map([['delegated-worker', { type: 'running' }]]),
      sendStates: {},
      workItems: rawWorkItems,
    });
    const tasksById = new Map<string, (typeof boardResult.working)[number]>();
    for (const row of Object.values(boardResult).flat()) {
      tasksById.set(row.workItemId, row);
      for (const member of row.members) {
        tasksById.set(member.session.id, row);
      }
    }

    const history: SessionHistoryParsed[] = [
      {
        id: 'u-1',
        role: 'user',
        timestamp: new Date(nowMs - 30_000).toISOString(),
        items: [{ type: 'text', text: 'Coordinate UI split-pane and tests' }],
      },
      {
        id: 'a-1',
        role: 'assistant',
        timestamp: new Date(nowMs - 25_000).toISOString(),
        items: [
          {
            type: 'tool_call',
            toolCallId: 'tc-1',
            title: 'lody_coordinator_work_item',
            status: 'completed',
            rawInput: {
              workItemId: 'direct-lead',
              mode: 'direct',
              title: 'Split-pane co-design',
            },
          } as SessionHistoryParsed['items'][number],
          {
            type: 'coordinator_message',
            id: 'b-handoff',
            body: 'Opened direct session for UI co-design.',
            card: {
              kind: 'handoff',
              title: 'Co-design in direct session',
              workItemId: 'direct-lead',
              snapshotTurnBySession: { 'direct-lead': 'child-turn-1' },
              actions: [
                {
                  id: 'act-open',
                  label: 'Open direct session',
                  intent: {
                    kind: 'client_command',
                    command: 'panel.open',
                    params: { sessionId: 'direct-lead', target: 'session' },
                  },
                },
              ],
            },
          },
        ],
      },
    ];

    const diagnostics: SessionCoordinatorDiagnosticsResponse = {
      type: 'session/coordinator-diagnostics_response',
      sessionId: coordinator.id as SessionId,
      observedAt: nowMs,
      cursors: [
        {
          targetSessionId: 'direct-lead',
          latestUserMsgId: 'child-turn-1',
          lastMessageAt: nowMs - 40_000,
          statusSignature: 'idle',
          prSignature: '',
          updatedAt: nowMs - 35_000,
        },
        {
          targetSessionId: 'delegated-worker',
          latestUserMsgId: 'worker-turn-1',
          lastMessageAt: nowMs - 20_000,
          statusSignature: 'running',
          prSignature: '',
          updatedAt: nowMs - 19_000,
        },
      ],
      lastTurnDelta: {
        userTurnId: 'u-1',
        deltaText:
          '<project_facts_delta>\n<work_item id="direct-lead" task="T1" />\n</project_facts_delta>',
        updatedAt: nowMs - 29_000,
      },
      operations: [],
      waits: [
        {
          id: 'watch-ci',
          state: 'waiting',
          checks: 3,
          consecutiveErrors: 0,
          nextCheckAt: nowMs + 5_000,
          reason: 'Wait for PR #2801 CI',
          program: 'return await coordinator.workItems();',
          continuation: { state: 'pending' },
        },
      ],
    };

    const snapshot = buildCoordinatorObservabilitySnapshot({
      coordinatorSessionId: coordinator.id,
      currentUserId: 'user-1',
      history,
      tasksById,
      rawWorkItems,
      presenceStates: {
        viewer: {
          kind: 'session-viewing',
          userId: 'user-1',
          sessionId: 'direct-lead' as SessionId,
          updatedAt: nowMs - 1_000,
        },
        runner: {
          kind: 'session',
          sessionId: 'delegated-worker' as SessionId,
          status: { type: 'running' },
          updatedAt: nowMs - 500,
        },
      },
      diagnostics,
      nowMs,
    });

    expect(snapshot.diagnosticsConnected).toBe(true);
    expect(snapshot.metrics).toMatchObject({
      workItemCount: 2,
      directWorkItemCount: 1,
      activeWorkerCount: 1,
      pullRequestCount: 1,
      openCardCount: 0,
      supersededCardCount: 1,
      pendingDeltaCount: 1,
      activeWatchCount: 1,
      suppressedWatchCount: 1,
    });
    expect(snapshot.viewedChildSessionIds.has('direct-lead')).toBe(true);
    expect(snapshot.liveActiveNodes.has('workers')).toBe(true);
    expect(snapshot.liveActiveEdges.has('workers_to_store')).toBe(true);
    expect(snapshot.cards[0]?.verdict).toBe('superseded_by_child');
    expect(snapshot.cards[0]?.snapshotChecks[0]).toMatchObject({
      sessionId: 'direct-lead',
      frozenTurnId: 'child-turn-1',
      currentTurnId: 'child-turn-2',
      diverged: true,
    });
    expect(snapshot.watches[0]?.gateVerdict).toBe('suppressed_focus');
    expect(snapshot.cursorAudits.find((c) => c.sessionId === 'direct-lead')?.status).toBe(
      'pending_turn_delta'
    );
    expect(snapshot.cursorAudits.find((c) => c.sessionId === 'delegated-worker')?.status).toBe(
      'synced'
    );
    expect(snapshot.events.map((e) => e.kind)).toEqual(
      expect.arrayContaining([
        'user_turn',
        'work_item_tool',
        'proactive_card',
        'card_superseded',
        'cursor_delta_injected',
        'cursor_lag_pending',
        'watch_gate_status',
      ])
    );
  });

  it('includes standalone Blackboard Task Cards without child sessions and summarizes multi-repo PR CI/mergeability', () => {
    const childSession = session('child-1', {
      openedBySessionId: coordinator.id as SessionId,
      createdAt: '2026-11-12T00:05:00.000Z',
      lastMessageAt: 500,
      pullRequests: [
        {
          url: 'https://github.com/LodyAI/lody/pull/3270',
          repoFullName: 'LodyAI/lody',
          number: 3270,
          status: 'open',
        },
        {
          url: 'https://github.com/LodyAI/sorbet/pull/324',
          repoFullName: 'LodyAI/sorbet',
          number: 324,
          status: 'open',
        },
      ],
      pullRequestState: {
        'https://github.com/LodyAI/lody/pull/3270': { s: 's', m: 'c', t: 100 },
        'https://github.com/LodyAI/sorbet/pull/324': { s: 'f', m: 'd', t: 100 },
      },
    });
    const result = buildProjectBoard({
      sessions: [coordinator, childSession],
      childSessionsByParent: buildChildSessionsByParent([coordinator, childSession]),
      project,
      coordinatorSessionId: coordinator.id,
      currentUserId: 'user-1',
      liveSessionStatuses: new Map(),
      sendStates: {},
      workItems: {
        'wi-proposed': {
          id: 'wi-proposed',
          title: 'Refactor auth middleware',
          stage: 'proposed',
          summary: 'Split token verification from session loading across 2 packages.',
          pendingAction: 'Confirm whether to keep legacy cookie fallback.',
          createdAt: Date.parse('2026-11-12T00:01:00.000Z'),
          updatedAt: 900,
        },
        'wi-done': {
          id: 'wi-done',
          title: 'Verify webhook timeout default',
          stage: 'done',
          progressNote: 'Confirmed default is 30s in gateway config.',
          acceptedAt: 800,
          createdAt: Date.parse('2026-11-12T00:02:00.000Z'),
          updatedAt: 800,
        },
        'wi-archived': {
          id: 'wi-archived',
          title: 'Dismissed idea',
          stage: 'proposed',
          archivedAt: 700,
          createdAt: Date.parse('2026-11-12T00:03:00.000Z'),
          updatedAt: 700,
        },
      },
    });

    expect(result.needsYou).toHaveLength(1);
    expect(result.needsYou[0]).toMatchObject({
      workItemId: 'wi-proposed',
      workItemTitle: 'Refactor auth middleware',
      stage: 'proposed',
      isStandalone: true,
      session: null,
      taskNumber: 1,
      pendingAction: 'Confirm whether to keep legacy cookie fallback.',
    });
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]).toMatchObject({
      workItemId: 'wi-done',
      stage: 'done',
      isStandalone: true,
      taskNumber: 2,
    });
    expect(result.review).toHaveLength(1);
    const prSummary = summarizeProjectBoardPullRequests(result.review[0]!.pullRequests);
    expect(prSummary).toEqual({
      total: 2,
      mergeable: 1,
      merged: 0,
      failingCi: 1,
      pendingCi: 0,
      conflicts: 1,
      draft: 0,
      open: 2,
    });
  });

  it('keeps blocked tasks in needsYou while siblings run, invalidates acceptance on new activity, includes manually grouped members, and marks disconnected cursors unknown', () => {
    const impl = session('impl-1', {
      openedBySessionId: coordinator.id as SessionId,
      workItemId: 'wi-squad',
      workItemRole: 'implement',
      createdAt: '2026-11-12T00:01:00.000Z',
      lastMessageAt: 500,
    });
    const manualReviewer = session('manual-review-1', {
      workItemId: 'wi-squad',
      workItemRole: 'review',
      createdAt: '2026-11-12T00:02:00.000Z',
      lastMessageAt: 600,
      pullRequests: [
        {
          url: 'https://github.com/LodyAI/lody/pull/3400',
          repoFullName: 'LodyAI/lody',
          number: 3400,
          status: 'open',
        },
      ],
    });
    const reactivated = session('reactivated-1', {
      openedBySessionId: coordinator.id as SessionId,
      workItemId: 'reactivated-1',
      createdAt: '2026-11-12T00:03:00.000Z',
      lastMessageAt: 900,
      coordinatorTaskAcceptedAt: 400,
    });

    const allSessions = [coordinator, impl, manualReviewer, reactivated];
    const workItems = {
      'wi-squad': {
        id: 'wi-squad',
        title: 'Squad blocked on decision',
        stage: 'blocked' as const,
        createdAt: Date.parse('2026-11-12T00:01:00.000Z'),
        updatedAt: 600,
      },
      'reactivated-1': {
        id: 'reactivated-1',
        title: 'Previously done then re-activated',
        stage: 'done' as const,
        acceptedAt: 400,
        createdAt: Date.parse('2026-11-12T00:03:00.000Z'),
        updatedAt: 400,
      },
    };

    const result = buildProjectBoard({
      sessions: allSessions,
      childSessionsByParent: buildChildSessionsByParent(allSessions),
      project,
      coordinatorSessionId: coordinator.id,
      currentUserId: 'user-1',
      liveSessionStatuses: new Map([['impl-1', { type: 'running' }]]),
      sendStates: {},
      workItems,
    });

    expect(result.needsYou).toHaveLength(1);
    expect(result.needsYou[0]).toMatchObject({
      workItemId: 'wi-squad',
      bucket: 'needsYou',
      stage: 'blocked',
    });
    expect(result.needsYou[0]!.members.map((m) => m.session.id)).toEqual([
      'impl-1',
      'manual-review-1',
    ]);
    expect(result.needsYou[0]!.pullRequests.map((p) => p.number)).toEqual([3400]);

    expect(result.accepted).toHaveLength(0);
    expect(result.review).toHaveLength(1);
    expect(result.review[0]).toMatchObject({
      workItemId: 'reactivated-1',
      bucket: 'review',
      stage: 'review',
    });

    const tasksById = new Map<string, (typeof result.needsYou)[number]>();
    for (const row of Object.values(result).flat()) {
      tasksById.set(row.workItemId, row);
      for (const m of row.members) tasksById.set(m.session.id, row);
    }
    const disconnectedSnapshot = buildCoordinatorObservabilitySnapshot({
      coordinatorSessionId: coordinator.id,
      currentUserId: 'user-1',
      history: [],
      tasksById,
      rawWorkItems: workItems,
      diagnostics: null,
      nowMs: 1_000,
    });
    expect(disconnectedSnapshot.diagnosticsConnected).toBe(false);
    expect(disconnectedSnapshot.cursorAudits.every((c) => c.status === 'unknown')).toBe(true);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type AgentConfigMeta,
  buildLiveActivityConversationItems,
  countLiveActivityConversationCandidates,
  countLiveActivityConversationStatuses,
  findLiveActivityPermissionAlertCandidate,
  selectPermissionOptionId,
  type SessionMeta,
  type SessionStatus,
} from '@lody/shared';

const baseSession = {
  id: 'session-1',
  machineId: 'machine-1',
  createdAt: '2026-06-02T00:00:00.000Z',
  userId: 'user-1',
  cliType: 'builtin',
  agentType: 'codex',
} as const;

const labels = {
  permission: 'Request Permission',
  question: 'Question',
  running: 'Running',
  unread: 'Completed',
} as const;

function buildItems(sessions: SessionMeta[]) {
  return buildLiveActivityConversationItems({
    sessions,
    currentUserId: 'user-1',
    defaultTitle: 'New Task',
    statusLabels: labels,
    formatUpdatedAt: (updatedAt) => String(updatedAt),
  });
}

describe('buildLiveActivityConversationItems', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('includes permission, running, and completed-unread sessions in priority order', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-02T12:00:00.000Z'));

    const now = Date.now();
    const items = buildItems([
      {
        ...baseSession,
        id: 'unread',
        title: 'Unread task',
        lastMessageAt: now - 10_000,
        lastReadAt: now - 20_000,
        status: { type: 'idle' },
      } as SessionMeta,
      {
        ...baseSession,
        id: 'running',
        title: 'Running task',
        lastMessageAt: now - 30_000,
        lastRunningSeen: now,
        status: { type: 'running' },
      } as SessionMeta,
      {
        ...baseSession,
        id: 'permission',
        title: 'Permission task',
        lastMessageAt: now - 60_000,
        lastRunningSeen: now,
        status: { type: 'requestPermission' },
      } as SessionMeta,
      {
        ...baseSession,
        id: 'question',
        title: 'Question task',
        lastMessageAt: now - 70_000,
        lastRunningSeen: now,
        status: { type: 'requestPermission' },
      } as SessionMeta,
    ]);

    expect(items.map((item) => item.id)).toEqual(['permission', 'question', 'running', 'unread']);
    expect(items.map((item) => item.status)).toEqual([
      'permission',
      'permission',
      'running',
      'unread',
    ]);
    expect(items.find((item) => item.id === 'permission')?.permissionRequestId).toBeUndefined();
    expect(items.find((item) => item.id === 'permission')?.permissionCommand).toBeUndefined();
    expect(items.find((item) => item.id === 'question')?.permissionRequestId).toBeUndefined();
    expect(items.find((item) => item.id === 'question')?.permissionCommand).toBeUndefined();
    expect(
      countLiveActivityConversationStatuses({
        sessions: [
          {
            ...baseSession,
            id: 'unread',
            title: 'Unread task',
            lastMessageAt: now - 10_000,
            lastReadAt: now - 20_000,
            status: { type: 'idle' },
          } as SessionMeta,
          {
            ...baseSession,
            id: 'running',
            title: 'Running task',
            lastMessageAt: now - 30_000,
            lastRunningSeen: now,
            status: { type: 'running' },
          } as SessionMeta,
          {
            ...baseSession,
            id: 'permission',
            title: 'Permission task',
            lastMessageAt: now - 60_000,
            lastRunningSeen: now,
            status: { type: 'requestPermission' },
          } as SessionMeta,
          {
            ...baseSession,
            id: 'question',
            title: 'Question task',
            lastMessageAt: now - 70_000,
            lastRunningSeen: now,
            status: { type: 'requestPermission' },
          } as SessionMeta,
        ],
        currentUserId: 'user-1',
      })
    ).toEqual({ permission: 2, question: 0, running: 1, unread: 1 });
  });

  it('does not report a quiescent session as running only because its goal is active', () => {
    const session = {
      ...baseSession,
      status: { type: 'idle' },
      lastMessageAt: 100,
      lastReadAt: 200,
      latestGoal: {
        type: 'goal',
        threadId: 'thread-1',
        objective: 'Keep the objective available',
        status: 'active',
      },
    } as unknown as SessionMeta;

    expect(buildItems([session])).toEqual([]);
    expect(
      buildLiveActivityConversationItems({
        sessions: [session],
        currentUserId: 'user-1',
        defaultTitle: 'New Task',
        statusLabels: labels,
        formatUpdatedAt: (updatedAt) => String(updatedAt),
        liveSessionStatuses: new Map(),
      })
    ).toEqual([]);
  });

  it('builds an alert candidate for the latest permission request', () => {
    const sessions = [
      {
        ...baseSession,
        id: 'question',
        title: 'Question task',
        lastMessageAt: 300,
        lastRunningSeen: Date.now(),
        status: { type: 'requestPermission' },
      },
      {
        ...baseSession,
        id: 'permission-old',
        title: 'Older permission task',
        lastMessageAt: 200,
        lastRunningSeen: Date.now(),
        status: { type: 'requestPermission' },
      },
      {
        ...baseSession,
        id: 'permission-new',
        title: 'Newer permission task',
        lastMessageAt: 400,
        lastRunningSeen: Date.now(),
        status: { type: 'requestPermission' },
      },
    ] as SessionMeta[];

    expect(
      findLiveActivityPermissionAlertCandidate({
        sessions,
        currentUserId: 'user-1',
        defaultTitle: 'New Task',
      })
    ).toEqual({
      key: 'permission-new:400',
      sessionTitle: 'Newer permission task',
      updatedAt: 400,
    });
  });

  it('builds an alert candidate for requestPermission without legacy details', () => {
    expect(
      findLiveActivityPermissionAlertCandidate({
        sessions: [
          {
            ...baseSession,
            id: 'question',
            title: 'Question task',
            lastMessageAt: 300,
            lastRunningSeen: Date.now(),
            status: { type: 'requestPermission' },
          } as SessionMeta,
        ],
        currentUserId: 'user-1',
        defaultTitle: 'New Task',
      })
    ).toEqual({
      key: 'question:300',
      sessionTitle: 'Question task',
      updatedAt: 300,
    });
  });

  it('filters stale permission and question requests when heartbeat expired', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-02T12:00:00.000Z'));

    const now = Date.now();
    const sessions = [
      {
        ...baseSession,
        id: 'permission-stale',
        title: 'Stale permission task',
        lastMessageAt: now - 1_000,
        lastRunningSeen: now - 240_000,
        status: { type: 'requestPermission' },
      },
      {
        ...baseSession,
        id: 'question-stale',
        title: 'Stale question task',
        lastMessageAt: now - 2_000,
        lastRunningSeen: now - 240_000,
        status: { type: 'requestPermission' },
      },
    ] as SessionMeta[];

    expect(buildItems(sessions)).toEqual([]);
    expect(
      countLiveActivityConversationCandidates({
        sessions,
        currentUserId: 'user-1',
      })
    ).toBe(0);
    expect(
      countLiveActivityConversationStatuses({
        sessions,
        currentUserId: 'user-1',
      })
    ).toEqual({ permission: 0, question: 0, running: 0, unread: 0 });
    expect(
      findLiveActivityPermissionAlertCandidate({
        sessions,
        currentUserId: 'user-1',
        defaultTitle: 'New Task',
      })
    ).toBeNull();
  });

  it('uses live session statuses when provided', () => {
    const sessions = [
      {
        ...baseSession,
        id: 'durable-running',
        title: 'Durable running task',
        lastMessageAt: 100,
        lastReadAt: 200,
        lastRunningSeen: Date.now(),
        status: { type: 'running' },
      },
      {
        ...baseSession,
        id: 'live-running',
        title: 'Live running task',
        lastMessageAt: 200,
        status: { type: 'idle' },
      },
      {
        ...baseSession,
        id: 'live-permission',
        title: 'Live permission task',
        lastMessageAt: 300,
        status: { type: 'idle' },
      },
    ] as SessionMeta[];
    const liveSessionStatuses = new Map<string, SessionStatus>([
      ['live-running', { type: 'running' }],
      ['live-permission', { type: 'requestPermission' }],
    ]);

    const items = buildLiveActivityConversationItems({
      sessions,
      currentUserId: 'user-1',
      defaultTitle: 'New Task',
      statusLabels: labels,
      formatUpdatedAt: (updatedAt) => String(updatedAt),
      liveSessionStatuses,
    });

    expect(items.map((item) => item.id)).toEqual(['live-permission', 'live-running']);
    expect(
      countLiveActivityConversationStatuses({
        sessions,
        currentUserId: 'user-1',
        liveSessionStatuses,
      })
    ).toEqual({ permission: 1, question: 0, running: 1, unread: 0 });
  });

  it('filters archived, other-user, and already-read sessions', () => {
    const sessions = [
      {
        ...baseSession,
        id: 'read',
        lastMessageAt: 200,
        lastReadAt: 300,
        status: { type: 'idle' },
      },
      {
        ...baseSession,
        id: 'archived',
        isArchived: true,
        lastMessageAt: 400,
        lastReadAt: 100,
      },
      {
        ...baseSession,
        id: 'other-user',
        userId: 'user-2',
        lastMessageAt: 500,
        lastReadAt: 100,
      },
    ] as SessionMeta[];

    expect(buildItems(sessions)).toEqual([]);
    expect(
      countLiveActivityConversationCandidates({
        sessions,
        currentUserId: 'user-1',
      })
    ).toBe(0);
  });

  it('uses agent config branding for the compact logo', () => {
    const agentConfig = {
      id: 'agent-1',
      machineId: 'machine-1',
      name: 'DeepSeek Claude',
      description: undefined,
      cliType: 'builtin',
      agentType: 'claude',
      brandId: 'deepseek',
      env: {},
      prompt: '',
    } as AgentConfigMeta;

    const items = buildLiveActivityConversationItems({
      sessions: [
        {
          ...baseSession,
          id: 'deepseek',
          cliType: 'builtin',
          agentType: 'claude',
          agentConfigId: 'agent-1',
          lastMessageAt: 500,
          lastReadAt: 100,
        } as SessionMeta,
      ],
      agentConfigs: [agentConfig],
      currentUserId: 'user-1',
      defaultTitle: 'New Task',
      statusLabels: labels,
      formatUpdatedAt: (updatedAt) => String(updatedAt),
    });

    expect(items[0]?.agentLogoText).toBe('DS');
    expect(items[0]?.agentLogoKind).toBe('deepseek');
  });
});

describe('selectPermissionOptionId', () => {
  it('prefers allow_always before allow_once for live activity allow actions', () => {
    expect(
      selectPermissionOptionId(
        [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'approve-fallback', name: 'Approve' },
          { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
        ],
        'allow'
      )
    ).toBe('allow-always');
  });

  it('falls back to allow-like labels and reject-like options', () => {
    expect(
      selectPermissionOptionId(
        [
          { optionId: 'approve-fallback', name: 'Approve' },
          { optionId: 'reject-once', name: 'Deny', kind: 'reject_once' },
        ],
        'allow'
      )
    ).toBe('approve-fallback');
    expect(
      selectPermissionOptionId(
        [
          { optionId: 'approve-fallback', name: 'Approve' },
          { optionId: 'reject-once', name: 'Deny', kind: 'reject_once' },
        ],
        'reject'
      )
    ).toBe('reject-once');
  });
});

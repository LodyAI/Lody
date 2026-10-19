import { describe, expect, it } from 'vitest';
import type { SessionId, WorkspaceId } from '../src/ids';
import {
  formatNotification,
  notificationMessages,
  resolveNotificationPresentation,
  notificationPresentationSchema,
  projectTurnAttention,
  terminalNotificationSchema,
  turnOutcomeKey,
  type TurnOutcomeFact,
} from '../src/notifications';

const fact: TurnOutcomeFact = {
  scope: { workspaceId: 'workspace' as WorkspaceId, recipientId: 'user' },
  sessionId: 'session' as SessionId,
  turnId: 'turn',
  audience: { kind: 'user' },
  outcome: { kind: 'succeeded' },
};

describe('notification source policy', () => {
  it.each(['succeeded', 'failed', 'unknown'] as const)(
    'preserves %s as an actionable user result',
    (kind) => {
      const item = projectTurnAttention({ ...fact, outcome: { kind, code: 'synthetic' } });
      expect(item).toEqual({
        id: JSON.stringify(['turn', 'workspace', 'user', 'session', 'turn']),
        scope: fact.scope,
        source: { kind: 'session', sessionId: fact.sessionId, turnId: fact.turnId },
        outcome: kind,
      });
    }
  );
  it('skips cancelled, delegated and unknown-provenance results', () => {
    expect(projectTurnAttention({ ...fact, outcome: { kind: 'cancelled' } })).toBeNull();
    expect(
      projectTurnAttention({
        ...fact,
        audience: { kind: 'agent', sessionId: 'parent' as SessionId, turnId: 'parent-turn' },
      })
    ).toBeNull();
    expect(projectTurnAttention({ ...fact, audience: { kind: 'unknown' } })).toBeNull();
  });
  it('keeps the existing provider identity across outcome changes and separates recipient/source turns', () => {
    expect(projectTurnAttention({ ...fact, outcome: { kind: 'failed', code: 'error' } })?.id).toBe(
      turnOutcomeKey(fact)
    );
    expect(turnOutcomeKey({ ...fact, turnId: 'next' })).not.toBe(turnOutcomeKey(fact));
    expect(turnOutcomeKey({ ...fact, scope: { ...fact.scope, recipientId: 'other' } })).not.toBe(
      turnOutcomeKey(fact)
    );
  });
  it('validates the same additive projection shape used by the writer and reader', () => {
    const projection = {
      id: 'a42f1111-1111-4111-8111-111111111111',
      recipientId: 'user',
      turnId: 'turn',
      outcome: 'failed',
      createdAt: 100,
    };
    expect(terminalNotificationSchema.parse({ ...projection, futureField: 'ignored' })).toEqual(
      projection
    );
    for (const invalid of [
      { ...projection, outcome: 'cancelled' },
      { ...projection, id: 'invalid' },
      { ...projection, recipientId: '' },
    ]) {
      expect(terminalNotificationSchema.safeParse(invalid).success).toBe(false);
    }
  });
});

describe('notification presentation', () => {
  const meta = {
    title: 'Fix sign-in',
    project: { kind: 'github' as const, repoFullName: 'team/lody', branch: 'main' },
  };
  const scheduled = {
    id: 'scheduled-input',
    scheduleRun: {
      scheduleId: 'daily',
      turnId: 'scheduled-input',
      title: 'Daily dependency check',
    },
  };
  const translate = (key: keyof typeof notificationMessages.zh) => notificationMessages.zh[key];

  it('separates scheduled work from manual input and copied input in the same conversation', () => {
    const presentation = resolveNotificationPresentation(meta, [scheduled]);
    expect(formatNotification('failed', presentation, translate)).toEqual({
      title: 'Fix sign-in',
      body: '定时任务失败 lody Daily dependency check',
    });
    for (const inputs of [
      [{ id: 'manual' }],
      [{ ...scheduled, id: 'edit-and-resend' }],
      [scheduled, { id: 'manual' }],
    ]) {
      expect(
        formatNotification('succeeded', resolveNotificationPresentation(meta, inputs), translate)
      ).toEqual({
        title: 'Fix sign-in',
        body: 'lody',
      });
    }
  });

  it('uses the originating task across summaries, but never chooses one task from mixed origins', () => {
    expect(
      resolveNotificationPresentation(meta, [
        scheduled,
        { ...scheduled, id: 'next', scheduleRun: { ...scheduled.scheduleRun, turnId: 'next' } },
      ]).kind
    ).toBe('schedule');
    expect(
      resolveNotificationPresentation(meta, [
        scheduled,
        { ...scheduled, scheduleRun: { ...scheduled.scheduleRun, scheduleId: 'another' } },
      ]).kind
    ).toBe('conversation');
    expect(
      formatNotification('question', resolveNotificationPresentation(meta, [scheduled]), translate)
        .body
    ).toBe('定时任务需要回答 lody Daily dependency check');
  });

  it('preserves the latest active PR in conversation and scheduled notifications', () => {
    const pullRequests = [
      { url: 'https://github.com/team/lody/pull/12', status: 'open' as const },
      { url: 'https://github.com/team/lody/pull/15', status: 'draft' as const },
      { url: 'https://github.com/team/lody/pull/18', status: 'merged' as const },
    ];
    for (const inputs of [[], [scheduled]]) {
      const presentation = resolveNotificationPresentation({ ...meta, pullRequests }, inputs);
      expect(notificationPresentationSchema.parse(presentation).pullRequestNumber).toBe(15);
      for (const event of ['succeeded', 'failed', 'unknown', 'permission', 'question'] as const) {
        expect(formatNotification(event, presentation, translate)).toEqual({
          title: 'Fix sign-in',
          body: `${event === 'succeeded' ? '' : `${translate(`notifications.copy.${presentation.kind}.${event}`)} `}lody PR #15${inputs.length ? ' Daily dependency check' : ''}`,
        });
      }
    }
    const finished = resolveNotificationPresentation(
      { pullRequests: [{ url: 'https://github.com/team/lody/pull/18', status: 'merged' }] },
      []
    );
    expect(formatNotification('succeeded', finished, translate).body).toBe('PR #18');
  });

  it('retains legacy PR recency and number while preferring the canonical URL', () => {
    const pullRequests = [
      {
        url: 'https://github.com/team/lody/pull/21',
        number: 99,
        status: 'open' as const,
        reportedAt: '2026-10-18',
      },
      {
        url: 'https://github.com/team/lody/pull/22',
        status: 'open' as const,
        reportedAt: '2026-10-17',
      },
    ];
    expect(resolveNotificationPresentation({ pullRequests }, []).pullRequestNumber).toBe(21);
    expect(
      resolveNotificationPresentation(
        { pullRequests: [{ url: '', number: 23, status: 'open' }] },
        []
      ).pullRequestNumber
    ).toBe(23);
    expect(
      resolveNotificationPresentation({ pullRequests: [{ url: 'invalid', status: 'open' }] }, [])
        .pullRequestNumber
    ).toBeUndefined();
    for (const number of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        notificationPresentationSchema.safeParse({
          kind: 'conversation',
          pullRequestNumber: number,
        }).success
      ).toBe(false);
    }
  });

  it('keeps the conversation title even for schedules and omits a repeated task name', () => {
    const presentation = resolveNotificationPresentation({ title: scheduled.scheduleRun.title }, [
      scheduled,
    ]);
    expect(formatNotification('succeeded', presentation, translate)).toEqual({
      title: 'Daily dependency check',
      body: '打开对话查看详情。',
    });
    expect(
      formatNotification('failed', resolveNotificationPresentation({}, [scheduled]), translate)
    ).toEqual({
      title: '未命名对话',
      body: '定时任务失败 Daily dependency check',
    });
  });

  it('bounds and cleans display names without including local paths', () => {
    const presentation = resolveNotificationPresentation(
      { title: '🚀'.repeat(200), project: { kind: 'local', localProjectId: 'local' as never } },
      [],
      ' My\nProject\u202e '
    );
    expect(presentation.projectName).toBe('My Project');
    expect(Array.from(presentation.conversationTitle ?? '')).toHaveLength(160);
    expect(presentation.conversationTitle?.endsWith('…')).toBe(true);
    expect(notificationPresentationSchema.safeParse(presentation).success).toBe(true);
    expect(formatNotification('unknown', undefined, translate)).toEqual({
      title: '未命名对话',
      body: '执行中断',
    });
  });
});

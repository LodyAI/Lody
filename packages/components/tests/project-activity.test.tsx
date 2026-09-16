import { describe, expect, it } from 'vitest';
import {
  getProjectActivityCounts,
  getProjectActivityItems,
  type ProjectActivityCounts,
} from '../src/components/project-activity';

type Flags = {
  permission?: boolean;
  unread?: boolean;
  active?: boolean;
};

function session(sessionId: string, flags: Flags) {
  return {
    sessionId,
    isWaitingPermission: flags.permission,
    hasUnreadMessages: flags.unread,
    isWorking: flags.active,
  };
}

function items(sessions: ReturnType<typeof session>[]) {
  return getProjectActivityItems(getProjectActivityCounts(sessions));
}

describe('collapsed project activity aggregation', () => {
  it.each([
    ['empty', [], []],
    [
      'one permission request',
      [session('p', { permission: true })],
      [{ status: 'permission', count: 1 }],
    ],
    ['one unread result', [session('u', { unread: true })], [{ status: 'unread', count: 1 }]],
    ['one active Session', [session('a', { active: true })], [{ status: 'active', count: 1 }]],
    [
      'one Session that is active and unread',
      [session('a', { active: true, unread: true })],
      [{ status: 'active', count: 1 }],
    ],
    [
      'permission plus another Session that is active and unread',
      [session('p', { permission: true }), session('a', { active: true, unread: true })],
      [
        { status: 'permission', count: 1 },
        { status: 'more', count: 1 },
      ],
    ],
    [
      'unread and active Sessions',
      [session('u', { unread: true }), session('a', { active: true })],
      [
        { status: 'unread', count: 1 },
        { status: 'active', count: 1 },
      ],
    ],
    [
      'same Session is not repeated after the primary slot',
      [session('p', { permission: true, unread: true }), session('a', { active: true })],
      [
        { status: 'permission', count: 1 },
        { status: 'active', count: 1 },
      ],
    ],
  ])('%s', (_name, sources, expected) => {
    expect(items(sources)).toEqual(expected);
  });

  it('deduplicates duplicate and nested sources and counts mixed remainder Sessions once', () => {
    const sources = [
      session('p', { permission: true }),
      session('a', { active: true, unread: true }),
    ];
    const counts = getProjectActivityCounts(sources);
    const nested: { sessionId: string; projectActivityCounts: ProjectActivityCounts } = {
      sessionId: 'group',
      projectActivityCounts: counts,
    };

    for (const input of [sources, [...sources, ...sources], [nested], [nested, ...sources]]) {
      expect(getProjectActivityItems(getProjectActivityCounts(input))).toEqual([
        { status: 'permission', count: 1 },
        { status: 'more', count: 1 },
      ]);
    }
  });
});

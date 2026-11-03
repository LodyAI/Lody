import { describe, expect, it } from 'vitest';
import type { SessionId } from '@lody/shared';
import { selectHighOwners, type OwnerActivityInput } from './pr-poll-priority';

const sid = (value: string): SessionId => value as SessionId;
const T0 = 1_720_000_000_000;
const OPTIONS = { activityWindowMs: 10 * 60_000, highOwnerCap: 100 };

function owner(
  id: string,
  overrides: Partial<Omit<OwnerActivityInput, 'ownerSessionId'>> = {}
): OwnerActivityInput {
  return {
    ownerSessionId: sid(id),
    memberSessionIds: [sid(id)],
    lastMessageAtMs: null,
    ...overrides,
  };
}

describe('selectHighOwners', () => {
  it('promotes viewed owners (any member counts) and recent-activity owners', () => {
    const high = selectHighOwners(
      [
        owner('viewed'),
        owner('viewed-via-child', { memberSessionIds: [sid('viewed-via-child'), sid('tab')] }),
        owner('active', { lastMessageAtMs: T0 - 5 * 60_000 }),
        owner('stale', { lastMessageAtMs: T0 - 11 * 60_000 }),
        owner('silent'),
      ],
      new Set([sid('viewed'), sid('tab')]),
      T0,
      OPTIONS
    );

    expect(high).toEqual(new Set([sid('viewed'), sid('viewed-via-child'), sid('active')]));
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildMissingEmail, type WorkspaceId } from '@lody/shared';

import { SessionUserResolver } from '../src/session/session-user-resolver';
import { resolveSessionGitIdentity } from '../src/session/git-identity';
import type { Logger } from '../src/utils/logger';

const WORKSPACE_ID = 'workspace_1' as WorkspaceId;
const testLogger = (): Logger =>
  ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  }) as unknown as Logger;

type ProfileQuery = ConstructorParameters<typeof SessionUserResolver>[2];

const createResolver = (queryProfile: ProfileQuery) =>
  new SessionUserResolver(testLogger(), WORKSPACE_ID, queryProfile);

describe('SessionUserResolver', () => {
  afterEach(() => vi.useRealTimers());

  it('binds owner turns to machine Git identity without querying the cloud', async () => {
    const query = vi.fn<ProfileQuery>(() => new Promise(() => {}));
    const resolver = new SessionUserResolver(testLogger(), WORKSPACE_ID, query, 'owner');
    const owner = await resolver.resolve('owner');
    expect(owner.id).toBe('owner');
    expect(
      resolveSessionGitIdentity(owner, {
        preferMachineIdentity: true,
        machineIdentity: { name: 'Local Owner', email: 'local@example.com' },
      })
    ).toEqual({ name: 'Local Owner', email: 'local@example.com' });
    expect(
      resolveSessionGitIdentity(owner, {
        preferMachineIdentity: true,
        machineIdentity: {},
      })
    ).toEqual({ name: 'LodyAI', email: 'agent@lody.ai' });
    expect(query).not.toHaveBeenCalled();
  });

  it('still resolves a non-owner profile and never attributes it to the machine owner', async () => {
    const resolver = new SessionUserResolver(
      testLogger(),
      WORKSPACE_ID,
      async () => ({ id: 'guest', name: 'Guest', email: 'guest@example.com' }),
      'owner'
    );
    const guest = await resolver.resolve('guest');
    expect(
      resolveSessionGitIdentity(guest, {
        preferMachineIdentity: false,
        machineIdentity: { name: 'Owner', email: 'owner@example.com' },
      })
    ).toEqual({ name: 'Guest', email: 'guest@example.com' });
  });

  it('bounds a hung query to one minute, retries, and ignores late results', async () => {
    vi.useFakeTimers();
    let finishOld: (profile: Awaited<ReturnType<ProfileQuery>>) => void = () => {};
    const old = new Promise<Awaited<ReturnType<ProfileQuery>>>((resolve) => {
      finishOld = resolve;
    });
    const fresh = { id: 'guest', name: 'Fresh', email: 'fresh@example.com' };
    const query = vi.fn<ProfileQuery>().mockReturnValueOnce(old).mockResolvedValue(fresh);
    const resolver = new SessionUserResolver(testLogger(), WORKSPACE_ID, query, 'owner');
    let settled = false;
    const pending = resolver.resolve('guest').then((profile) => {
      settled = true;
      return profile;
    });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const fallback = await pending;
    expect(
      resolveSessionGitIdentity(fallback, {
        preferMachineIdentity: false,
        machineIdentity: { name: 'Owner', email: 'owner@example.com' },
      })
    ).toEqual({ name: 'LodyAI', email: 'agent@lody.ai' });
    expect(vi.getTimerCount()).toBe(0);
    await expect(resolver.resolve('guest')).resolves.toEqual(fresh);
    finishOld({ id: 'guest', name: 'Old', email: 'old@example.com' });
    await old;
    await expect(resolver.resolve('guest')).resolves.toEqual(fresh);
  });

  it('cleans up the deadline after success and retries a failed query', async () => {
    vi.useFakeTimers();
    const fresh = { id: 'guest', name: 'Guest', email: 'guest@example.com' };
    const query = vi
      .fn<ProfileQuery>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(fresh);
    const resolver = createResolver(query);
    await expect(resolver.resolve('guest')).resolves.toMatchObject({
      email: buildMissingEmail('lody', 'guest'),
    });
    await expect(resolver.resolve('guest')).resolves.toEqual(fresh);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves the requesting user real name and email', async () => {
    const queryProfile = vi.fn(async () => ({
      id: 'user_a',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
    }));
    const resolver = createResolver(queryProfile);

    await expect(resolver.resolve('user_a')).resolves.toEqual({
      id: 'user_a',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
    });
    expect(queryProfile).toHaveBeenCalledWith('user_a');
  });

  it('uses the GitHub no-reply address when the stored email is a missing-email placeholder', async () => {
    const resolver = createResolver(
      vi.fn(async () => ({
        id: 'user_a',
        name: 'Ada Lovelace',
        email: buildMissingEmail('github', '4324'),
        githubLogin: 'ada',
        githubAccountId: '4324',
      }))
    );

    await expect(resolver.resolve('user_a')).resolves.toEqual({
      id: 'user_a',
      name: 'Ada Lovelace',
      email: '4324+ada@users.noreply.github.com',
    });
  });

  it('prefers the real account email over the GitHub no-reply address', async () => {
    const resolver = createResolver(
      vi.fn(async () => ({
        id: 'user_a',
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        githubLogin: 'ada',
        githubAccountId: '4324',
      }))
    );

    await expect(resolver.resolve('user_a')).resolves.toMatchObject({
      email: 'ada@example.com',
    });
  });

  it('falls back to the GitHub login when the account has no name', async () => {
    const resolver = createResolver(
      vi.fn(async () => ({
        id: 'user_a',
        email: 'ada@example.com',
        githubLogin: 'ada',
        githubAccountId: '4324',
      }))
    );

    await expect(resolver.resolve('user_a')).resolves.toEqual({
      id: 'user_a',
      name: 'ada',
      email: 'ada@example.com',
    });
  });

  it('falls back to the placeholder identity when the user cannot be resolved', async () => {
    const resolver = createResolver(vi.fn(async () => null));

    await expect(resolver.resolve('user_a')).resolves.toEqual({
      id: 'user_a',
      name: buildMissingEmail('lody', 'user_a'),
      email: buildMissingEmail('lody', 'user_a'),
    });
  });

  it('falls back to the placeholder identity when the query throws', async () => {
    const resolver = createResolver(
      vi.fn(async () => {
        throw new Error('convex unreachable');
      })
    );

    await expect(resolver.resolve('user_a')).resolves.toEqual({
      id: 'user_a',
      name: buildMissingEmail('lody', 'user_a'),
      email: buildMissingEmail('lody', 'user_a'),
    });
  });

  it('keeps the resolved profile until clear() permits a fresh lookup', async () => {
    let name = 'Original';
    const resolver = createResolver(async () => ({
      id: 'user_a',
      name,
      email: 'ada@example.com',
    }));
    await expect(resolver.resolve('user_a')).resolves.toMatchObject({ name: 'Original' });
    name = 'Updated';
    await expect(resolver.resolve('user_a')).resolves.toMatchObject({ name: 'Original' });
    resolver.clear();
    await expect(resolver.resolve('user_a')).resolves.toMatchObject({ name: 'Updated' });
  });
});

import { describe, expect, it, vi } from 'vitest';
import { buildMissingEmail, type WorkspaceId } from '@lody/shared';

import { SessionUserResolver } from '../src/session/session-user-resolver';
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

  it('prefers the GitHub no-reply address over a real account email', async () => {
    const resolver = createResolver(
      vi.fn(async () => ({
        id: 'user_a',
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        githubLogin: 'ada',
        githubAccountId: '4324',
      }))
    );

    // A real account email is exactly the address GitHub rejects with GH007 when
    // the account keeps its email private and blocks command-line pushes.
    await expect(resolver.resolve('user_a')).resolves.toEqual({
      id: 'user_a',
      name: 'Ada Lovelace',
      email: '4324+ada@users.noreply.github.com',
    });
  });

  it('keeps the account email when the GitHub profile is incomplete', async () => {
    const resolver = createResolver(
      vi.fn(async () => ({
        id: 'user_a',
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        githubLogin: 'ada',
      }))
    );

    await expect(resolver.resolve('user_a')).resolves.toEqual({
      id: 'user_a',
      name: 'Ada Lovelace',
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
      email: '4324+ada@users.noreply.github.com',
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

  it('caches a resolved profile per user and re-queries after clear()', async () => {
    const queryProfile = vi.fn(async () => ({
      id: 'user_a',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
    }));
    const resolver = createResolver(queryProfile);

    await resolver.resolve('user_a');
    await resolver.resolve('user_a');
    expect(queryProfile).toHaveBeenCalledTimes(1);

    resolver.clear();
    await resolver.resolve('user_a');
    expect(queryProfile).toHaveBeenCalledTimes(2);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveGitIdentityPolicyLegacy } from '../src/session/git-identity-policy';
import { buildMissingEmail } from '@lody/shared';

import {
  buildGitHubNoreplyEmail,
  DEFAULT_AI_GIT_AUTHOR_EMAIL,
  DEFAULT_AI_GIT_AUTHOR_NAME,
  resolveSessionGitIdentity,
} from '../src/session/git-identity';

describe('resolveSessionGitIdentity', () => {
  it('uses the machine identity first for the machine owner', () => {
    expect(
      resolveSessionGitIdentity(
        { name: 'Ada', email: 'ada@example.com' },
        {
          preferMachineIdentity: true,
          machineIdentity: { name: 'Local User', email: 'local@example.com' },
        }
      )
    ).toEqual({
      name: 'Local User',
      email: 'local@example.com',
    });
  });

  it('uses the Lody identity when the machine owner has no Git identity', () => {
    expect(
      resolveSessionGitIdentity(
        { name: 'Ada', email: 'ada@example.com' },
        { preferMachineIdentity: true, machineIdentity: {} }
      )
    ).toEqual({
      name: 'Ada',
      email: 'ada@example.com',
    });
  });

  it('uses the LodyAI identity when the machine owner has no usable identity', () => {
    expect(
      resolveSessionGitIdentity(
        { name: 'github-user', email: buildMissingEmail('github', '123') },
        { preferMachineIdentity: true, machineIdentity: {} }
      )
    ).toEqual({
      name: DEFAULT_AI_GIT_AUTHOR_NAME,
      email: DEFAULT_AI_GIT_AUTHOR_EMAIL,
    });
  });

  it('never uses the machine identity for a non-owner', () => {
    expect(
      resolveSessionGitIdentity(
        { name: 'Teammate', email: 'teammate@example.com' },
        {
          preferMachineIdentity: false,
          machineIdentity: { name: 'Machine Owner', email: 'owner@example.com' },
        }
      )
    ).toEqual({
      name: 'Teammate',
      email: 'teammate@example.com',
    });
  });

  it('falls back to the LodyAI identity for a non-owner without a usable identity', () => {
    expect(
      resolveSessionGitIdentity(
        { name: 'github-user', email: buildMissingEmail('github', '123') },
        {
          preferMachineIdentity: false,
          machineIdentity: { name: 'Machine Owner', email: 'owner@example.com' },
        }
      )
    ).toEqual({
      name: DEFAULT_AI_GIT_AUTHOR_NAME,
      email: DEFAULT_AI_GIT_AUTHOR_EMAIL,
    });
  });

  it('keeps a GitHub no-reply commit email over the host identity', () => {
    const noreply = buildGitHubNoreplyEmail('4324', 'ada');
    expect(
      resolveSessionGitIdentity(
        { name: 'Ada', email: noreply },
        {
          preferMachineIdentity: false,
          machineIdentity: { email: 'local@example.com' },
        }
      )
    ).toEqual({
      name: 'Ada',
      email: '4324+ada@users.noreply.github.com',
    });
  });
});

describe('buildGitHubNoreplyEmail', () => {
  it('builds the canonical id+login attribution address', () => {
    expect(buildGitHubNoreplyEmail('1234567', 'ada')).toBe('1234567+ada@users.noreply.github.com');
  });

  it('trims surrounding whitespace', () => {
    expect(buildGitHubNoreplyEmail(' 1234567 ', ' ada ')).toBe(
      '1234567+ada@users.noreply.github.com'
    );
  });

  it('returns undefined without both a numeric account id and a login', () => {
    expect(buildGitHubNoreplyEmail('1234567', undefined)).toBeUndefined();
    expect(buildGitHubNoreplyEmail(undefined, 'ada')).toBeUndefined();
    expect(buildGitHubNoreplyEmail('', 'ada')).toBeUndefined();
    // A non-numeric id is not a GitHub account id; the address would not attribute.
    expect(buildGitHubNoreplyEmail('not-an-id', 'ada')).toBeUndefined();
  });
});

describe('Git identity policy deadline', () => {
  const logger = { debug: () => {}, warn: () => {} };
  afterEach(() => vi.useRealTimers());

  it('keeps the successful personal identity preference', async () => {
    expect(
      await resolveGitIdentityPolicyLegacy(async () => ({ personalEnabled: true }), logger, 'test')
    ).toEqual({ personalEnabled: true });
  });

  it('retries a rejected lookup once and uses the second answer', async () => {
    const lookup = vi
      .fn<() => Promise<{ personalEnabled: boolean }>>()
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValueOnce({ personalEnabled: true });
    expect(await resolveGitIdentityPolicyLegacy(lookup, logger, 'test')).toEqual({
      personalEnabled: true,
    });
  });

  it('falls back after two rejections instead of retrying indefinitely', async () => {
    const lookup = vi
      .fn<() => Promise<{ personalEnabled: boolean }>>()
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockRejectedValueOnce(new Error('still unavailable'))
      .mockResolvedValue({ personalEnabled: true });
    expect(await resolveGitIdentityPolicyLegacy(lookup, logger, 'test')).toEqual({
      personalEnabled: false,
    });
  });

  it('ignores a timed-out answer while the retry is in flight', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const first = Promise.withResolvers<{ personalEnabled: boolean }>();
    const second = Promise.withResolvers<{ personalEnabled: boolean }>();
    const lookup = vi
      .fn<() => Promise<{ personalEnabled: boolean }>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const pending = resolveGitIdentityPolicyLegacy(lookup, logger, 'test');
    await vi.advanceTimersByTimeAsync(3_000);
    first.resolve({ personalEnabled: true });
    second.resolve({ personalEnabled: false });
    expect(await pending).toEqual({ personalEnabled: false });
  });

  it('bounds two hung requests and ignores late success after fallback', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const request = Promise.withResolvers<{ personalEnabled: boolean }>();
    const pending = resolveGitIdentityPolicyLegacy(() => request.promise, logger, 'test');
    await vi.advanceTimersByTimeAsync(6_000);
    const result = await pending;
    expect(result).toEqual({ personalEnabled: false });
    request.resolve({ personalEnabled: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toEqual({ personalEnabled: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels without fallback or retry and ignores late rejection', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const request = Promise.withResolvers<{ personalEnabled: boolean }>();
    const controller = new AbortController();
    const pending = resolveGitIdentityPolicyLegacy(
      () => request.promise,
      logger,
      'test',
      controller.signal
    );
    const rejected = expect(pending).rejects.toThrow('cancelled');
    controller.abort(new Error('cancelled'));
    await rejected;
    request.reject(new Error('late failure'));
    await vi.advanceTimersByTimeAsync(6_000);
    expect(vi.getTimerCount()).toBe(0);
  });
});

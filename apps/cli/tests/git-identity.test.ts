import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resolveApprovedOwnerIdentityLegacy,
  resolveGitIdentityPolicyLegacy,
} from '../src/session/git-identity-policy';

import { buildGitHubNoreplyEmail } from '../src/session/git-identity';

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

describe('approved owner identity lookup', () => {
  const logger = { debug: () => {}, warn: () => {} };
  afterEach(() => vi.useRealTimers());

  it('returns the owner account identity', async () => {
    const owner = { name: 'Owner', email: 'owner@example.com' };
    expect(await resolveApprovedOwnerIdentityLegacy(async () => owner, logger, 'test')).toEqual(
      owner
    );
  });

  it('keeps local Git identity when the account lookup hangs or fails', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const pending = resolveApprovedOwnerIdentityLegacy(() => new Promise(() => {}), logger, 'test');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await pending).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    await expect(
      resolveApprovedOwnerIdentityLegacy(
        async () => {
          throw new Error('offline');
        },
        logger,
        'test'
      )
    ).resolves.toBeUndefined();
  });
});

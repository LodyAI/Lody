import { describe, expect, it } from 'vitest';
import { buildMissingEmail } from '@lody/shared';
import { buildGitHubNoreplyEmail, resolveSessionGitIdentity } from './git-identity';

const requester = { name: 'Requester', email: 'requester@example.invalid' };

describe('resolveSessionGitIdentity', () => {
  it('leaves owner identity to Git even when a requester profile is available', () => {
    expect(resolveSessionGitIdentity(requester, { preferMachineIdentity: true })).toBeNull();
  });

  it('normalizes a non-owner profile and preserves a GitHub no-reply address', () => {
    expect(
      resolveSessionGitIdentity(
        { name: ' Requester ', email: ' requester@example.invalid ' },
        { preferMachineIdentity: false }
      )
    ).toEqual(requester);
    expect(
      resolveSessionGitIdentity(
        { name: '', email: buildGitHubNoreplyEmail('123', 'member') },
        { preferMachineIdentity: false }
      )
    ).toEqual({
      name: '123+member@users.noreply.github.com',
      email: '123+member@users.noreply.github.com',
    });
  });

  it.each(['', ' ', buildMissingEmail('github', '123')])(
    'uses the neutral identity for unusable member email %s',
    (email) => {
      expect(
        resolveSessionGitIdentity({ name: 'Member', email }, { preferMachineIdentity: false })
      ).toEqual({ name: 'LodyAI', email: 'agent@lody.ai' });
    }
  );
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

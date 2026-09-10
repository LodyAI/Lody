import { describe, expect, it } from 'vitest';

import {
  titleToBranchName,
  isValidGitBranchName,
  tryBranchName,
} from '../src/agent/branch-name-generator';

describe('branch-name-generator', () => {
  describe('titleToBranchName', () => {
    it('converts simple titles to kebab-case with prefix', () => {
      // "Add" is detected as a feature keyword, so prefix is stripped
      expect(titleToBranchName('Add dark mode')).toBe('feat/dark-mode');
      expect(titleToBranchName('Fix login bug')).toBe('fix/login-bug');
      expect(titleToBranchName('Update dependencies')).toBe('chore/dependencies');
    });

    it('detects fix-related patterns', () => {
      expect(titleToBranchName('Fix authentication error')).toBe('fix/authentication-error');
      // "Resolve" triggers fix prefix but isn't stripped
      expect(titleToBranchName('Resolve crash on startup')).toBe('fix/resolve-crash-on-startup');
      expect(titleToBranchName('Bug in user registration')).toBe('fix/in-user-registration');
    });

    it('detects feature-related patterns', () => {
      expect(titleToBranchName('Add user profile page')).toBe('feat/user-profile-page');
      expect(titleToBranchName('Implement OAuth2')).toBe('feat/oauth2');
      expect(titleToBranchName('Create new dashboard')).toBe('feat/new-dashboard');
    });

    it('detects refactor-related patterns', () => {
      expect(titleToBranchName('Refactor database layer')).toBe('refactor/database-layer');
      // "Improve" triggers refactor but isn't stripped
      expect(titleToBranchName('Improve performance')).toBe('refactor/improve-performance');
      // "Clean" triggers refactor but isn't stripped
      expect(titleToBranchName('Clean up legacy code')).toBe('refactor/clean-up-legacy-code');
    });

    it('detects docs-related patterns', () => {
      // "Document" triggers docs but isn't stripped
      expect(titleToBranchName('Document API endpoints')).toBe('docs/document-api-endpoints');
      expect(titleToBranchName('Update README')).toBe('docs/readme');
    });

    it('detects test-related patterns', () => {
      // "Add" has higher priority than "test" in detection
      expect(titleToBranchName('Add test coverage')).toBe('feat/test-coverage');
      // "Write" doesn't match test pattern, but "tests" does
      expect(titleToBranchName('Write unit tests for utils')).toBe('feat/write-unit-tests-for-utils');
    });

    it('detects chore-related patterns', () => {
      expect(titleToBranchName('Update npm packages')).toBe('chore/npm-packages');
      // "Bump" triggers chore but isn't stripped
      expect(titleToBranchName('Bump version to 2.0')).toBe('chore/bump-version-to-20');
      // "Upgrade" triggers chore but isn't stripped
      expect(titleToBranchName('Upgrade TypeScript')).toBe('chore/upgrade-typescript');
    });

    it('removes special characters', () => {
      expect(titleToBranchName("Fix user's profile (issue #123)")).toBe('fix/users-profile-issue-123');
      // "feature:" pattern gets stripped
      expect(titleToBranchName('Add feature: dark mode')).toBe('feat/feature-dark-mode');
    });

    it('limits length to 50 characters', () => {
      const longTitle = 'Add a very long feature that spans multiple words and should be truncated';
      const result = titleToBranchName(longTitle);
      expect(result.length).toBeLessThanOrEqual(50);
    });

    it('handles empty or invalid input', () => {
      expect(titleToBranchName('')).toBe('');
      expect(titleToBranchName(null as any)).toBe('');
      expect(titleToBranchName(undefined as any)).toBe('');
    });
  });

  describe('isValidGitBranchName', () => {
    it('accepts valid branch names', () => {
      expect(isValidGitBranchName('feat/add-dark-mode')).toBe(true);
      expect(isValidGitBranchName('fix/issue-123')).toBe(true);
      expect(isValidGitBranchName('main')).toBe(true);
      expect(isValidGitBranchName('release/v1.0.0')).toBe(true);
    });

    it('rejects invalid branch names', () => {
      expect(isValidGitBranchName('.hidden')).toBe(false);
      expect(isValidGitBranchName('-dash-start')).toBe(false);
      expect(isValidGitBranchName('branch.lock')).toBe(false);
      expect(isValidGitBranchName('with..dots')).toBe(false);
      expect(isValidGitBranchName('with spaces')).toBe(false);
      expect(isValidGitBranchName('with@{at}')).toBe(false);
      expect(isValidGitBranchName('')).toBe(false);
      expect(isValidGitBranchName(null as any)).toBe(false);
    });
  });

  describe('tryBranchName', () => {
    it('returns the generated branch name when valid', () => {
      expect(tryBranchName('Fix login bug')).toBe('fix/login-bug');
    });

    it('returns null for empty input', () => {
      expect(tryBranchName('')).toBeNull();
    });

    // Kebab conversion strips every non-ASCII character, leaving nothing to name
    // the branch after; the caller keeps the branch it already has.
    it('returns null when the input has no ASCII words', () => {
      expect(tryBranchName('把标题生成迁移到会话协议')).toBeNull();
    });

    // A branch name is a ref: it reaches the remote when the session opens a PR,
    // so a prompt carrying a credential must not name the branch. Secrets have no
    // reliable shape, so the boundary fails closed on the syntax that carries them
    // and the session keeps its `session/<id>` branch.
    it.each([
      ['an assignment to a sensitive name', 'Fix DB_PASSWORD=hunter2'],
      ['a lowercase assignment', 'debug with password: correcthorse'],
      ['an AWS-style assignment', 'set AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI'],
      ['URL userinfo', 'Fix https://alice:hunter2@example.com'],
      ['an Authorization header', 'Authorization: Bearer eyJhbGciOiJIUzI1'],
      ['a known key prefix', 'Fix API key sk_live_ABC123def456'],
      ['a GitHub token', 'update ghp_16C7e42F292c6912E7710c838347Ae178B4a'],
      ['an unprefixed hex secret', 'token is 0123456789abcdef0123456789abcdef'],
      [
        'a PEM block',
        'paste -----BEGIN RSA PRIVATE KEY----- MIIEow -----END RSA PRIVATE KEY-----',
      ],
    ])('refuses to name a branch after %s', (_label, prompt) => {
      expect(tryBranchName(prompt)).toBeNull();
    });

    // Failing closed is only affordable because it does not fire on ordinary work.
    // These all mention a sensitive word without carrying a value.
    it.each([
      ['Fix crash when opening FooBar with empty input', 'fix/crash-when-opening-foobar-with-empty-input'],
      ['Bump codex to 1.10.1 and grok to 0.1.3', 'chore/bump-codex-to-1101-and-grok-to-013'],
      ['Fix auth redirect loop after logout', 'fix/auth-redirect-loop-after-logout'],
      ['Add a token bucket rate limiter', 'feat/a-token-bucket-rate-limiter'],
      ['Support GITHUB_TOKEN in CI', 'feat/support-github-token-in-ci'],
      ['Write tests for the credential broker', 'feat/write-tests-for-the-credential-broker'],
    ])('still names a branch after %s', (prompt, expected) => {
      expect(tryBranchName(prompt)).toBe(expected);
    });
  });
});

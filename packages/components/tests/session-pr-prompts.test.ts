import i18next from 'i18next';
import { beforeAll, describe, expect, it } from 'vitest';
import type { GitHubCheckRun, GitHubPullRequestDetails } from '@lody/shared';
import { buildFixCiErrorsPrompt } from '../src/components/sessions/session-pr-prompts';
import {
  mapGitHubCheckRunToPrCiRun,
  summarizePrCiRuns,
} from '../src/components/sessions/session-info-chips';
import { initI18n } from '../src/i18n';

const pullRequest: GitHubPullRequestDetails = {
  number: 42,
  nodeId: 'PR_42',
  title: 'Improve PR automation',
  body: '',
  state: 'open',
  merged: false,
  draft: false,
  htmlUrl: 'https://github.com/loro-dev/lody/pull/42',
  baseRef: 'develop',
  headRef: 'improve-pr-automation',
  headSha: 'head-42',
  user: null,
  createdAt: '2026-07-20T00:00:00.000Z',
  updatedAt: '2026-07-20T00:01:00.000Z',
  mergedAt: null,
  closedAt: null,
  additions: 10,
  deletions: 2,
  changedFiles: 3,
  commits: 1,
  mergeable: true,
  mergeableState: 'clean',
};

function checkRun(
  name: string,
  conclusion: GitHubCheckRun['conclusion'],
  status: GitHubCheckRun['status'] = 'completed'
): GitHubCheckRun {
  return {
    id: name.length,
    name,
    status,
    conclusion,
    htmlUrl: `https://github.com/loro-dev/lody/actions/runs/${name.length}`,
    startedAt: null,
    completedAt: null,
    appName: 'GitHub Actions',
  };
}

const tFor = (language: 'en' | 'zh_CN') => i18next.getFixedT(language);

describe('session PR prompts', () => {
  beforeAll(async () => {
    await initI18n('en');
  });

  it('includes the refreshed PR snapshot and only failed checks in the CI repair prompt', () => {
    const failing = checkRun('test', 'failure');
    const prompt = buildFixCiErrorsPrompt(
      {
        repoFullName: 'loro-dev/lody',
        pullRequest,
        checkRuns: {
          status: 'completed',
          conclusion: 'failure',
          total: 3,
          runs: [failing, checkRun('lint', 'success'), checkRun('build', null, 'in_progress')],
        },
      },
      tFor('en')
    );

    expect(prompt).toContain('loro-dev/lody pull request #42');
    expect(prompt).toContain('Head SHA: head-42');
    expect(prompt).toContain('untrusted data');
    expect(prompt).toContain(`- ${failing.name} · GitHub Actions · failure · ${failing.htmlUrl}`);
    expect(prompt).not.toContain('- lint');
    expect(prompt).not.toContain('- build');
    expect(prompt?.length).toBeLessThanOrEqual(6_000);
  });

  it('does not send a CI repair prompt when a fresh check fetch has no failures', () => {
    expect(
      buildFixCiErrorsPrompt(
        {
          repoFullName: 'loro-dev/lody',
          pullRequest,
          checkRuns: {
            status: 'completed',
            conclusion: 'success',
            total: 1,
            runs: [checkRun('test', 'success')],
          },
        },
        tFor('en')
      )
    ).toBeNull();
  });
});

describe('PR CI verdict', () => {
  const verdict = (runs: GitHubCheckRun[]) =>
    summarizePrCiRuns(runs.map(mapGitHubCheckRunToPrCiRun));

  it('does not report a cancelled check as a CI failure', () => {
    expect(verdict([checkRun('test', 'success'), checkRun('deploy', 'cancelled')])).toBe('passing');
    expect(verdict([checkRun('test', 'failure'), checkRun('deploy', 'cancelled')])).toBe('failing');
  });
});

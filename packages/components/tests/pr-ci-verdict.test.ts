import { describe, expect, it } from 'vitest';
import type { GitHubCheckRun } from '@lody/shared';
import {
  mapGitHubCheckRunToPrCiRun,
  summarizePrCiRuns,
} from '../src/components/sessions/session-info-chips';

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

describe('PR CI verdict', () => {
  const verdict = (runs: GitHubCheckRun[]) =>
    summarizePrCiRuns(runs.map(mapGitHubCheckRunToPrCiRun));

  it('does not report a cancelled check as a CI failure', () => {
    expect(verdict([checkRun('test', 'success'), checkRun('deploy', 'cancelled')])).toBe('passing');
    expect(verdict([checkRun('test', 'failure'), checkRun('deploy', 'cancelled')])).toBe('failing');
  });
});

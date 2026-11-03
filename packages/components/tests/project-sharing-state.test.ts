import { describe, expect, it } from 'vitest';
import { projectSharingReducer, type ProjectSharingState } from '../src/lib/project-sharing-state';

const key = 'machine-1:project-1';

function begin(
  state: ProjectSharingState = {},
  desired = true,
  requestId = 1
): ProjectSharingState {
  return projectSharingReducer(state, { type: 'begin', key, desired, requestId });
}

describe('project sharing state', () => {
  it('keeps an acknowledged value until a delayed query catches up', () => {
    const saving = begin();
    const acknowledged = projectSharingReducer(saving, {
      type: 'succeeded',
      key,
      requestId: 1,
      observedSharedWithTeam: false,
    });

    expect(acknowledged[key]).toEqual({
      desired: true,
      requestId: 1,
      status: 'awaiting-sync',
    });
    expect(
      projectSharingReducer(acknowledged, {
        type: 'reconcile',
        sharedWithTeamByKey: new Map([[key, false]]),
      })
    ).toBe(acknowledged);
    expect(
      projectSharingReducer(acknowledged, {
        type: 'reconcile',
        sharedWithTeamByKey: new Map([[key, true]]),
      })
    ).toEqual({});
  });

  it('rolls back a failed request', () => {
    expect(
      projectSharingReducer(begin(), {
        type: 'failed',
        key,
        requestId: 1,
      })
    ).toEqual({});
  });

  it('ignores stale completions from an older request', () => {
    const newer = begin(begin(), false, 2);

    expect(
      projectSharingReducer(newer, {
        type: 'failed',
        key,
        requestId: 1,
      })
    ).toBe(newer);
    expect(
      projectSharingReducer(newer, {
        type: 'succeeded',
        key,
        requestId: 1,
        observedSharedWithTeam: true,
      })
    ).toBe(newer);
  });
});

import { describe, expect, it } from 'vitest';

import { isPlanExitApproval, resolveModeIdAfterPlanExit } from '../src/lib/plan-mode-exit';

const PLAN_EXIT_OPTIONS = [
  { optionId: 'proceed', name: 'Yes, implement this plan', kind: 'allow_always' },
  { optionId: 'proceed-once', name: 'Yes, and manually approve edits', kind: 'allow_once' },
  { optionId: 'keep-planning', name: 'No, keep planning', kind: 'reject_once' },
];

describe('plan mode exit', () => {
  it('treats any approved answer on the plan switch as leaving plan mode', () => {
    expect(isPlanExitApproval({ kind: 'switch_mode' }, PLAN_EXIT_OPTIONS, 'proceed')).toBe(true);
    expect(isPlanExitApproval({ kind: 'switch_mode' }, PLAN_EXIT_OPTIONS, 'proceed-once')).toBe(
      true
    );
  });

  it('does not treat a declined plan switch as leaving plan mode', () => {
    expect(isPlanExitApproval({ kind: 'switch_mode' }, PLAN_EXIT_OPTIONS, 'keep-planning')).toBe(
      false
    );
    expect(isPlanExitApproval({ kind: 'switch_mode' }, PLAN_EXIT_OPTIONS, 'unknown-option')).toBe(
      false
    );
  });

  it('ignores approvals on ordinary tool calls', () => {
    expect(
      isPlanExitApproval(
        { kind: 'edit' },
        [{ optionId: 'proceed', name: 'Allow', kind: 'allow_once' }],
        'proceed'
      )
    ).toBe(false);
  });

  it('exits to the agent default mode, and never stays on plan', () => {
    const modeOptions = [
      { value: 'default', label: 'Default' },
      { value: 'acceptEdits', label: 'Accept edits' },
      { value: 'plan', label: 'Plan' },
    ];

    expect(resolveModeIdAfterPlanExit(modeOptions, 'acceptEdits')).toBe('acceptEdits');
    // A default of `plan` must not keep the user in plan mode.
    expect(resolveModeIdAfterPlanExit(modeOptions, 'plan')).toBe('default');
    expect(resolveModeIdAfterPlanExit(modeOptions, null)).toBe('default');
    expect(resolveModeIdAfterPlanExit([{ value: 'plan', label: 'Plan' }], 'plan')).toBeNull();
    expect(resolveModeIdAfterPlanExit([], null)).toBeNull();
  });
});

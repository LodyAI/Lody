import type { SessionDoc } from '@lody/shared';
import { describe, expect, it, vi } from 'vitest';

import {
  CODEX_COLLABORATION_MODE_CONFIG_ID,
  CODEX_COLLABORATION_MODE_DEFAULT_VALUE,
  CODEX_COLLABORATION_MODE_PLAN_VALUE,
  CODEX_FAST_MODE_CONFIG_ID,
  CONFIG_OPTION_ON_VALUE,
} from '../src/components/shared/acp-selector-options';
import {
  disableCodexPlanMode,
  dispatchCodexExecutionPrompt,
  findLatestCompletedCodexProposedPlan,
  isCodexPlanModeEnabled,
  shouldShowCodexProposedPlanDecision,
} from '../src/lib/codex-plan-decision';

const makeHistory = (items: unknown[], id = 'assistant-turn'): SessionDoc['history'] =>
  [
    {
      id,
      $cid: id,
      role: 'assistant',
      items,
      timestamp: new Date().toISOString(),
      fileDiff: [],
      read: false,
    },
  ] as unknown as SessionDoc['history'];

describe('codex plan decision helpers', () => {
  it('finds the latest completed Codex proposed plan', () => {
    const history = makeHistory([
      {
        type: 'proposed_plan',
        turnId: 'turn-delta',
        markdown: '# Draft',
        status: 'delta',
        isLatest: true,
      },
      {
        type: 'proposed_plan',
        turnId: 'turn-completed',
        markdown: '# Final plan',
        status: 'completed',
        isLatest: true,
      },
    ]);

    expect(findLatestCompletedCodexProposedPlan(history)).toEqual({
      key: 'assistant-turn:turn-completed',
      entryId: 'assistant-turn',
      turnId: 'turn-completed',
    });
  });

  it('ignores stale, empty, and non-completed proposed plans', () => {
    const history = makeHistory([
      {
        type: 'proposed_plan',
        turnId: 'turn-stale',
        markdown: '# Stale',
        status: 'completed',
        isLatest: false,
      },
      {
        type: 'proposed_plan',
        turnId: 'turn-empty',
        markdown: '  ',
        status: 'completed',
        isLatest: true,
      },
      {
        type: 'proposed_plan',
        turnId: 'turn-cleared',
        markdown: '# Cleared',
        status: 'cleared',
        isLatest: true,
      },
    ]);

    expect(findLatestCompletedCodexProposedPlan(history)).toBeNull();
  });

  it('keeps the plan entry id when a newer plain assistant reply exists', () => {
    const history = [
      ...makeHistory(
        [
          {
            type: 'proposed_plan',
            turnId: 'turn-plan',
            markdown: '# Final plan',
            status: 'completed',
            isLatest: true,
          },
        ],
        'plan-reply'
      ),
      ...makeHistory([{ type: 'text', text: 'A later normal reply' }], 'plain-reply'),
    ] as SessionDoc['history'];

    expect(findLatestCompletedCodexProposedPlan(history)).toEqual({
      key: 'plan-reply:turn-plan',
      entryId: 'plan-reply',
      turnId: 'turn-plan',
    });
  });

  it('detects and disables Codex collaboration plan mode', () => {
    const config = {
      [CODEX_COLLABORATION_MODE_CONFIG_ID]: CODEX_COLLABORATION_MODE_PLAN_VALUE,
      [CODEX_FAST_MODE_CONFIG_ID]: CONFIG_OPTION_ON_VALUE,
      reasoning_effort: 'low',
    };

    expect(isCodexPlanModeEnabled(config)).toBe(true);
    expect(disableCodexPlanMode(config)).toEqual({
      [CODEX_COLLABORATION_MODE_CONFIG_ID]: CODEX_COLLABORATION_MODE_DEFAULT_VALUE,
      [CODEX_FAST_MODE_CONFIG_ID]: CONFIG_OPTION_ON_VALUE,
      reasoning_effort: 'low',
    });
  });

  it('reports plan mode off when collaboration mode is absent or default', () => {
    expect(isCodexPlanModeEnabled({})).toBe(false);
    expect(
      isCodexPlanModeEnabled({
        [CODEX_COLLABORATION_MODE_CONFIG_ID]: CODEX_COLLABORATION_MODE_DEFAULT_VALUE,
      })
    ).toBe(false);
  });

  it('dispatches execution with Plan disabled and persists only an accepted transition', async () => {
    const dispatch = vi.fn().mockResolvedValue(true);
    const onPlanModeDisabled = vi.fn();
    const config = {
      [CODEX_COLLABORATION_MODE_CONFIG_ID]: CODEX_COLLABORATION_MODE_PLAN_VALUE,
      reasoning_effort: 'high',
    };

    await expect(
      dispatchCodexExecutionPrompt({ configOptionValues: config, dispatch, onPlanModeDisabled })
    ).resolves.toBe(true);

    const expected = {
      [CODEX_COLLABORATION_MODE_CONFIG_ID]: CODEX_COLLABORATION_MODE_DEFAULT_VALUE,
      reasoning_effort: 'high',
    };
    expect(dispatch).toHaveBeenCalledWith(expected);
    expect(onPlanModeDisabled).toHaveBeenCalledWith(expected);
  });

  it('keeps the local Plan selection when execution dispatch is rejected', async () => {
    const dispatch = vi.fn().mockResolvedValue(false);
    const onPlanModeDisabled = vi.fn();

    await expect(
      dispatchCodexExecutionPrompt({
        configOptionValues: {
          [CODEX_COLLABORATION_MODE_CONFIG_ID]: CODEX_COLLABORATION_MODE_PLAN_VALUE,
        },
        dispatch,
        onPlanModeDisabled,
      })
    ).resolves.toBe(false);

    expect(onPlanModeDisabled).not.toHaveBeenCalled();
  });

  it('does not add a collaboration override when Plan is already off', async () => {
    const dispatch = vi.fn().mockResolvedValue(true);
    const onPlanModeDisabled = vi.fn();

    await dispatchCodexExecutionPrompt({
      configOptionValues: { reasoning_effort: 'low' },
      dispatch,
      onPlanModeDisabled,
    });

    expect(dispatch).toHaveBeenCalledWith(undefined);
    expect(onPlanModeDisabled).not.toHaveBeenCalled();
  });

  it('keeps the completed plan decision visible after plan mode is manually disabled', () => {
    const plan = findLatestCompletedCodexProposedPlan(
      makeHistory([
        {
          type: 'proposed_plan',
          turnId: 'turn-completed',
          markdown: '# Final plan',
          status: 'completed',
          isLatest: true,
        },
      ])
    );
    const config = disableCodexPlanMode({
      [CODEX_COLLABORATION_MODE_CONFIG_ID]: CODEX_COLLABORATION_MODE_PLAN_VALUE,
    });

    expect(isCodexPlanModeEnabled(config)).toBe(false);
    expect(
      shouldShowCodexProposedPlanDecision({
        plan,
        dismissed: false,
        pending: false,
        isCodexSession: true,
        isSessionIdle: true,
        isSessionActive: false,
        isAgentBusy: false,
      })
    ).toBe(true);
  });
});

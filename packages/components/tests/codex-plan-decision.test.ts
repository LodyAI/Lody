import type { SessionDoc } from '@lody/shared';
import { describe, expect, it } from 'vitest';

import {
  CODEX_COLLABORATION_MODE_CONFIG_ID,
  CODEX_COLLABORATION_MODE_DEFAULT_VALUE,
  CODEX_COLLABORATION_MODE_PLAN_VALUE,
  CODEX_FAST_MODE_CONFIG_ID,
  CONFIG_OPTION_ON_VALUE,
} from '../src/components/shared/acp-selector-options';
import {
  disableCodexPlanMode,
  findLatestCompletedCodexProposedPlan,
  isCodexPlanModeEnabled,
} from '../src/lib/codex-plan-decision';

const makeHistory = (items: unknown[]): SessionDoc['history'] =>
  [
    {
      id: 'assistant-turn',
      $cid: 'assistant-turn',
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
});

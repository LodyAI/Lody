import { describe, expect, it } from 'vitest';
import { buildSessionTurnInputConfig, type McpServerId } from '@lody/shared';

import {
  applyTurnScopedOverrides,
  buildPermissionRetryOverrides,
  pickTurnScopedOverrides,
} from '../src/lib/turn-scoped-overrides';
import { findPermissionNotAppliedRetryTarget } from '../src/lib/permission-not-applied-retry';

/** What the composer would contribute if nothing overrode it. */
const composerArgs = {
  inputBlocks: [{ type: 'text' as const, text: 'ship it' }],
  cliType: 'builtin' as const,
  agentType: 'claude',
  modeId: 'plan',
  mcpServerIds: ['server-the-user-picked-later'] as McpServerId[],
  taskToolsEnabled: true,
  issuePRMentions: [{ number: 99 }] as never[],
};

describe('turn-scoped overrides reach the wire', () => {
  const stoppedHistory = [
    {
      id: 'user-1',
      role: 'user',
      inputConfig: {
        inputBlocks: [{ type: 'text', text: 'ship it' }],
        modeId: 'plan',
        modelId: 'model-b',
        configOptionValues: { reasoning_effort: 'high' },
        mcpServerIds: [],
        taskToolsEnabled: false,
        issuePRMentions: [{ number: 7 }],
      },
    },
    {
      id: 'notice-1',
      role: 'system',
      items: [
        {
          type: 'system_notice',
          name: 'chat_failed',
          meta: {
            reason: 'permission_not_applied',
            permission: {
              controlId: 'permission-mode',
              requestedModeId: 'plan',
              effectiveModeId: 'auto',
            },
          },
        },
      ],
    },
  ];

  it('carries the acceptance and the frozen turn config through every send route', () => {
    const target = findPermissionNotAppliedRetryTarget(stoppedHistory);
    expect(target).not.toBeNull();

    // The route the button takes: dispatch options → each hop's narrowing →
    // the args `buildSessionTurnInputConfig` is finally called with.
    const dispatchOptions = { ...buildPermissionRetryOverrides(target!) };
    const afterHops = pickTurnScopedOverrides(pickTurnScopedOverrides(dispatchOptions));
    const config = buildSessionTurnInputConfig(applyTurnScopedOverrides(composerArgs, afterHops));

    expect(config.acceptWiderPermissions).toEqual([
      { controlId: 'permission-mode', requestedModeId: 'plan', effectiveModeId: 'auto' },
    ]);
    // The composer's own values lost to the stopped turn's, including the
    // explicit empty MCP selection and `taskToolsEnabled: false`.
    expect(config.mcpServerIds).toEqual([]);
    expect(config.taskToolsEnabled).toBe(false);
    expect(config.issuePRMentions).toEqual([{ number: 7 }]);
  });

  it('leaves an ordinary send entirely to the composer', () => {
    const config = buildSessionTurnInputConfig(
      applyTurnScopedOverrides(composerArgs, pickTurnScopedOverrides(undefined))
    );

    expect(config.acceptWiderPermissions).toBeUndefined();
    expect(config.mcpServerIds).toEqual(['server-the-user-picked-later']);
    expect(config.taskToolsEnabled).toBe(true);
  });

  it('keeps a stopped turn that pinned nothing extra from inventing values', () => {
    // No MCP/task/mention fields on the frozen config: the composer's stay.
    const overrides = buildPermissionRetryOverrides({
      disclosed: {
        controlId: 'permission-mode',
        requestedModeId: 'plan',
        effectiveModeId: 'auto',
      },
      previouslyAccepted: [],
    });
    const config = buildSessionTurnInputConfig(
      applyTurnScopedOverrides(composerArgs, pickTurnScopedOverrides(overrides))
    );

    expect(config.acceptWiderPermissions).toEqual([
      { controlId: 'permission-mode', requestedModeId: 'plan', effectiveModeId: 'auto' },
    ]);
    expect(config.mcpServerIds).toEqual(['server-the-user-picked-later']);
    expect(config.taskToolsEnabled).toBe(true);
  });

  it('accumulates the disclosures already accepted on the stopped turn', () => {
    // Two controls widened at once, so they are disclosed one stop at a time.
    // A replay carrying only the newest acceptance drops the previous one and
    // lands back on the first stop — the user would alternate forever.
    const first = { controlId: 'permission_mode', requestedModeId: 'ask', effectiveModeId: 'auto' };
    const second = {
      controlId: 'interaction_mode',
      requestedModeId: 'plan',
      effectiveModeId: 'auto',
    };

    const config = buildSessionTurnInputConfig(
      applyTurnScopedOverrides(
        composerArgs,
        pickTurnScopedOverrides(
          buildPermissionRetryOverrides({ disclosed: second, previouslyAccepted: [first] })
        )
      )
    );

    expect(config.acceptWiderPermissions).toEqual([first, second]);
  });

  it('does not duplicate a disclosure the stopped turn already accepted', () => {
    const only = { controlId: 'permission_mode', requestedModeId: 'ask', effectiveModeId: 'auto' };

    expect(
      buildPermissionRetryOverrides({ disclosed: only, previouslyAccepted: [only] })
        .acceptWiderPermissions
    ).toEqual([only]);
  });
});

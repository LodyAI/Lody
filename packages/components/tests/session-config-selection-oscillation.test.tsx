// @vitest-environment jsdom

/**
 * The composer's selector options are built FROM the selection (the
 * `useSessionAcpSelectorContext` cycle), and the regression these tests pin
 * comes from a real session (51e236e0-b0d0-4c47-a74b-f8cfe2e97a91, 0.89.x,
 * React error #185 on open). Its stored turn preferences carry a config option
 * the agent's runtime snapshot does not report:
 *
 *   turn inputConfig: builtin/claude, mode `auto`, model `claude-fable-5[1m]`,
 *     configOptionValues `{ effort: high, fast: false }`
 *   acpRuntimeConfig (revision 1, based on that same turn): mode `auto`,
 *     model `claude-fable-5`,
 *     configOptionValues `{ effort: high, mode: auto, model: claude-fable-5 }`
 *
 * The old reconcile/apply layout-effect pair alternated on that key once per
 * render until React aborted with "Maximum update depth exceeded". The derived
 * hook stores only user edits, feeds the capability lookup from CANDIDATES,
 * and resolves the runtime-omitted key once, so this must mount and settle.
 */

import { useMemo } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveSessionAcpRuntimeConfig, resolveSessionConversationConfig } from '@lody/shared';
import { buildAcpSelectorOptions } from '../src/components/shared/acp-selector-options';
import {
  useAcpSessionConfigSelectionState,
  useResolvedAcpSessionConfigSelection,
} from '../src/hooks/use-acp-session-config-selection';

const SESSION_ID = 'session-with-runtime-config';
const LATEST_USER_TURN_ID = 'turn-latest';

const history = [
  {
    id: LATEST_USER_TURN_ID,
    role: 'user' as const,
    inputConfig: {
      prompt: 'done',
      cliType: 'builtin',
      agentType: 'claude',
      modeId: 'auto',
      modelId: 'claude-fable-5[1m]',
      configOptionValues: { effort: 'high', fast: false },
    },
  },
];

const acpRuntimeConfig = {
  acpSessionId: 'acp-session-1',
  basedOnUserTurnId: LATEST_USER_TURN_ID,
  revision: 1,
  modeId: 'auto',
  modelId: 'claude-fable-5',
  configOptionValues: { effort: 'high', mode: 'auto', model: 'claude-fable-5' },
};

const conversationConfig = resolveSessionConversationConfig(history, []);
const runtimeConfig = resolveSessionAcpRuntimeConfig(history, [], acpRuntimeConfig);

const preferences = {
  modeId: conversationConfig.modeId,
  modelId: conversationConfig.modelId,
  configOptionValues: conversationConfig.configOptionValues,
};
const preferenceRevision = `${SESSION_ID}:${conversationConfig.sourceConfigKey ?? ''}`;
const targetKey = `${SESSION_ID}:builtin:claude`;

describe('session composer config selection wiring (#185 regression)', () => {
  let container: HTMLDivElement;
  let root: Root | undefined;
  let renderCount = 0;
  let settledModelId: string | null = null;
  let settledConfigKeys: string[] = [];

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    renderCount = 0;
    settledModelId = null;
    settledConfigKeys = [];
    catalogBuilds = 0;
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    root = undefined;
    container.remove();
  });

  let catalogBuilds = 0;

  /** The `session-chat-interface.tsx` cycle: selection → options → selection. */
  function ConfigSelectionHarness({
    framePreferences = preferences,
    frameRuntimePreferences = runtimeConfig,
  }: {
    framePreferences?: typeof preferences;
    frameRuntimePreferences?: typeof runtimeConfig;
  }) {
    renderCount += 1;
    const controller = useAcpSessionConfigSelectionState({
      enabled: true,
      targetKey,
      preferenceRevision,
      preferences: framePreferences,
      runtimePreferences: frameRuntimePreferences,
      preserveUnsentUserEdits: true,
    });
    const selectorOptions = useMemo(() => {
      catalogBuilds += 1;
      return buildAcpSelectorOptions({
        cliType: 'builtin',
        agentType: 'claude',
        selectedModeId: controller.candidates.modeId,
        selectedModelId: controller.candidates.modelId,
        configOptionValues: controller.candidates.configOptionValues,
      });
    }, [controller.candidates]);
    const resolved = useResolvedAcpSessionConfigSelection(controller.selection, selectorOptions);
    settledModelId = resolved.selectedModelId;
    settledConfigKeys = Object.keys(resolved.configOptionValues).sort();
    return null;
  }

  it('reaches a stable render instead of looping the layout effect', () => {
    expect(() => {
      flushSync(() => root?.render(<ConfigSelectionHarness />));
    }).not.toThrow();
    // One render to mount, one for the fence adjustment. React aborts at 50
    // nested updates, so anything unbounded shows up here first.
    expect(renderCount).toBeLessThanOrEqual(3);
    // The runtime snapshot's values win, and its key set is final: the
    // preference-only `fast` is not re-seeded.
    expect(settledModelId).toBe('claude-fable-5');
    expect(settledConfigKeys).not.toContain('fast');
    expect(settledConfigKeys).toContain('effort');
  });

  it('keeps the selector catalog stable across value-equal document frames', () => {
    /* Streaming rebuilds `sessionDoc.history` — and thus the resolved
       preference/runtime object literals — with unchanged VALUES once per
       merge frame. The replaced reducer absorbed that churn by returning the
       same state object; the hook must absorb it too, or the catalog (and the
       memoized composer subtree fed from it) rebuilds on every frame of the
       conversation hot path. */
    flushSync(() => root?.render(<ConfigSelectionHarness />));
    const settledCatalogBuilds = catalogBuilds;
    for (let frame = 0; frame < 10; frame += 1) {
      const freshPreferences = {
        ...preferences,
        configOptionValues: { ...(preferences.configOptionValues ?? {}) },
      };
      const freshRuntime = runtimeConfig
        ? { ...runtimeConfig, configOptionValues: { ...(runtimeConfig.configOptionValues ?? {}) } }
        : runtimeConfig;
      flushSync(() =>
        root?.render(
          <ConfigSelectionHarness
            framePreferences={freshPreferences}
            frameRuntimePreferences={freshRuntime}
          />
        )
      );
    }
    expect(catalogBuilds).toBe(settledCatalogBuilds);
  });
});

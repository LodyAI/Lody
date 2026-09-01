// @vitest-environment jsdom

/**
 * The composer's selector options are built FROM the selection they reconcile,
 * so `useReconcileAcpSessionConfigSelection` re-runs on its own output: any
 * reconcile that keeps producing a new state re-renders the conversation until
 * React aborts the commit with "Maximum update depth exceeded".
 *
 * The regression these tests pin comes from a real session
 * (51e236e0-b0d0-4c47-a74b-f8cfe2e97a91, web 0.89.2, React error #185). Its
 * stored turn preferences carry a config option the agent's runtime snapshot
 * does not report, so the two rules alternated once per render:
 *
 *   turn inputConfig: builtin/claude, mode `auto`, model `claude-fable-5[1m]`,
 *     configOptionValues `{ effort: high, fast: false }`
 *   acpRuntimeConfig (revision 1, based on that same turn): mode `auto`,
 *     model `claude-fable-5`,
 *     configOptionValues `{ effort: high, mode: auto, model: claude-fable-5 }`
 *
 * `reconcile` seeded `fast` back from the preferences, the runtime snapshot
 * dropped it again as an option it does not own, and neither pass ever agreed.
 */

import React, { useMemo } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveSessionAcpRuntimeConfig, resolveSessionConversationConfig } from '@lody/shared';
import {
  buildAcpSelectorOptions,
  type AcpSelectorOptions,
} from '../src/components/shared/acp-selector-options';
import {
  createEmptyAcpSessionConfigSelectionState,
  getAcpSessionConfigOptionValues,
  reduceAcpSessionConfigSelection,
  type AcpSessionConfigSelectionState,
} from '../src/lib/acp-session-config-selection';
import {
  useAcpSessionConfigSelectionState,
  useReconcileAcpSessionConfigSelection,
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

/** What `useAcpSelectorOptions` builds for this target, minus i18n. */
const selectorOptionsFor = (state: AcpSessionConfigSelectionState): AcpSelectorOptions =>
  buildAcpSelectorOptions({
    cliType: 'builtin',
    agentType: 'claude',
    selectedModeId: state.mode.value,
    selectedModelId: state.model.value,
    configOptionValues: getAcpSessionConfigOptionValues(state),
  });

const reconcile = (state: AcpSessionConfigSelectionState): AcpSessionConfigSelectionState =>
  reduceAcpSessionConfigSelection(state, {
    type: 'reconcile',
    targetKey,
    preferenceRevision,
    preferences,
    runtimePreferences: runtimeConfig,
    preserveUnsentUserEdits: true,
    ...selectorOptionsFor(state),
  });

describe('ACP session config reconciliation is a fixed point', () => {
  it('settles a turn preference the runtime snapshot does not report', () => {
    const settled = reconcile(createEmptyAcpSessionConfigSelectionState());

    // The runtime snapshot owns the key set for the turn it is based on, so the
    // preference-only `fast` is dropped rather than re-seeded next pass.
    expect(getAcpSessionConfigOptionValues(settled)).toEqual({
      effort: 'high',
      mode: 'auto',
      model: 'claude-fable-5',
    });
    expect(settled.model.value).toBe('claude-fable-5');

    // Re-reconciling the same inputs must return the SAME object: an identity
    // change here is a re-render, and this state feeds the options it is
    // reconciled against.
    expect(reconcile(settled)).toBe(settled);
  });

  it('holds the fixed point while the selector options follow the selection', () => {
    let state = createEmptyAcpSessionConfigSelectionState();
    const keySets: string[] = [];
    for (let pass = 0; pass < 10; pass += 1) {
      const next = reconcile(state);
      keySets.push(JSON.stringify(Object.keys(getAcpSessionConfigOptionValues(next)).sort()));
      if (next === state) {
        expect(pass).toBeLessThanOrEqual(1);
        return;
      }
      state = next;
    }
    throw new Error(`selection never settled; config option keys cycled as ${keySets.join(' -> ')}`);
  });
});

describe('session composer config selection wiring', () => {
  let container: HTMLDivElement;
  let root: Root | undefined;
  let renderCount = 0;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    renderCount = 0;
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    root = undefined;
    container.remove();
  });

  /** The `session-chat-interface.tsx` cycle: selection -> options -> selection. */
  function ConfigSelectionHarness() {
    renderCount += 1;
    const { selectedModeId, selectedModelId, configOptionValues, dispatch } =
      useAcpSessionConfigSelectionState();
    const selectorOptions = useMemo(
      () =>
        buildAcpSelectorOptions({
          cliType: 'builtin',
          agentType: 'claude',
          selectedModeId,
          selectedModelId,
          configOptionValues,
        }),
      [configOptionValues, selectedModeId, selectedModelId]
    );
    useReconcileAcpSessionConfigSelection({
      enabled: true,
      targetKey,
      preferenceRevision,
      preferences,
      runtimePreferences: runtimeConfig,
      preserveUnsentUserEdits: true,
      selectorOptions,
      dispatch,
    });
    return null;
  }

  it('reaches a stable render instead of looping the layout effect', () => {
    expect(() => {
      flushSync(() => root?.render(<ConfigSelectionHarness />));
    }).not.toThrow();
    // One render to mount, one for the reconciled selection. React aborts at 50
    // nested updates, so anything unbounded shows up here first.
    expect(renderCount).toBeLessThanOrEqual(3);
  });
});

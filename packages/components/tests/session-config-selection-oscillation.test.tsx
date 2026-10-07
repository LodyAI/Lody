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

import { act, useMemo } from 'react';
import { Provider, createStore } from 'jotai';
import {
  sessionRunConfigDraftsAtom,
  setSessionRunConfigDraftAccountAtom,
} from '../src/atoms/session-run-config-drafts';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  resolveSessionAcpRuntimeConfig,
  resolveSessionConversationConfig,
  resolveSessionConversationSourceFence,
  type SessionHistory,
  type SessionId,
  type AgentRoleId,
} from '@lody/shared';
import { useSessionPendingConfig } from '../src/hooks/use-session-pending-config';
import { createPendingSessionSends } from '../src/lib/session-pending-sends';
import type { AcpSessionSelectorOptionsInput } from '../src/lib/acp-session-config-selection';
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
  let selectConfigOption: ReturnType<
    typeof useAcpSessionConfigSelectionState
  >['selectConfigOption'];

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
    selectConfigOption = controller.selectConfigOption;
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
    const settledSelectConfigOption = selectConfigOption;
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
    expect(selectConfigOption).toBe(settledSelectConfigOption);
  });
});

describe('composer configuration across attachment sends', () => {
  let container: HTMLDivElement;
  let root: Root;
  const sessionId = 'attachment-session' as SessionId;
  const otherSessionId = 'other-session' as SessionId;
  const roleId = 'synthetic-reviewer' as AgentRoleId;
  const catalog: AcpSessionSelectorOptionsInput = {
    capabilityAuthority: 'authoritative',
    modelOptions: ['default', 'chosen', 'next'].map((value) => ({ value, label: value })),
    modeOptions: ['read-only', 'agent'].map((value) => ({ value, label: value })),
    defaultModeId: 'read-only',
    defaultModelId: 'default',
    modelReasoningEfforts: undefined,
    configOptionSelectors: [
      {
        configId: 'effort',
        label: 'Effort',
        type: 'select',
        currentValue: 'low',
        options: ['low', 'high'].map((value) => ({ value, label: value })),
      },
    ],
  };
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  const turn = (id: string, modelId = 'chosen'): SessionHistory => ({
    id,
    role: 'user',
    userId: 'synthetic-user',
    timestamp: '2026-09-30T00:00:00.000Z',
    status: 'pending',
    items: [{ type: 'text', text: 'Synthetic attachment message' }],
    inputConfig: {
      modelId,
      modeId: 'agent',
      configOptionValues: { effort: 'high' },
      agentRoleId: roleId,
      agentRoleRevision: 2,
    },
    read: false,
    fileDiff: [],
    finished: true,
  });
  let durable: SessionHistory[];
  let landed: Set<string>;
  let preparation: ReturnType<typeof deferred>;
  let shouldFail: boolean;
  let pendingSends: ReturnType<typeof createPendingSessionSends>;
  let selection: ReturnType<typeof useAcpSessionConfigSelectionState>;
  let baseline: ReturnType<typeof useSessionPendingConfig>;

  function Harness({
    currentSessionId = sessionId,
    documentReady = true,
  }: {
    currentSessionId?: SessionId;
    documentReady?: boolean;
  }) {
    const rows = currentSessionId === sessionId ? durable : [];
    baseline = useSessionPendingConfig({
      sessionId: currentSessionId,
      pendingSends,
      history: { indexOf: (id) => (landed.has(id) ? 0 : -1) },
      config: resolveSessionConversationConfig(rows),
      sourceFence: resolveSessionConversationSourceFence(rows),
      documentReady,
    });
    selection = useAcpSessionConfigSelectionState({
      enabled: documentReady || baseline.hasPendingConfig,
      targetKey: currentSessionId,
      preferenceRevision: `${currentSessionId}:${baseline.sourceFence.currentTurnKey ?? ''}`,
      preferences: baseline.config,
      runtimePreferences: baseline.hasPendingConfig
        ? null
        : resolveSessionAcpRuntimeConfig(rows, [], {
            acpSessionId: 'synthetic-runtime',
            basedOnUserTurnId: 'old',
            revision: 1,
            modelId: 'default',
          }),
      preserveUnsentUserEdits: true,
    });
    const resolved = useResolvedAcpSessionConfigSelection(selection.selection, catalog);
    return (
      <output>
        {JSON.stringify({
          model: resolved.selectedModelId,
          mode: resolved.selectedModeId,
          effort: resolved.configOptionValues.effort,
          role: baseline.config.agentRoleId,
        })}
      </output>
    );
  }
  const render = (props: Parameters<typeof Harness>[0] = {}) => {
    flushSync(() => root.render(<Harness {...props} />));
  };
  const visible = () => JSON.parse(container.textContent!);
  const enqueue = (entry = turn('first'), target = sessionId) => {
    flushSync(() =>
      pendingSends.enqueue({
        id: entry.id,
        sessionId: target,
        workspaceId: 'synthetic-workspace',
        entry,
        delivery: { kind: 'history' },
        attachments: [
          {
            id: 'synthetic-attachment',
            kind: 'file',
            source: new File(['synthetic'], 'sample.txt', { type: 'text/plain' }),
          },
        ],
      })
    );
  };
  const settle = async () => {
    const completed = new Promise<void>((resolve) => {
      const unsubscribe = pendingSends.subscribe(() => {
        const sends = pendingSends.getSnapshot();
        if (sends.length && !sends.every((send) => send.error)) return;
        unsubscribe();
        resolve();
      });
    });
    await act(async () => {
      preparation.resolve();
      await completed;
    });
  };

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    durable = [];
    landed = new Set();
    preparation = deferred();
    shouldFail = false;
    pendingSends = createPendingSessionSends({
      prepare: async (send, signal) => {
        signal.addEventListener('abort', preparation.resolve, { once: true });
        await preparation.promise;
        if (signal.aborted) throw new DOMException('Canceled', 'AbortError');
        if (shouldFail) throw new Error('Synthetic preparation failure');
        return { entry: send.entry, queue: send.queue, attachments: [] };
      },
      write: async (send) => {
        landed.add(send.id);
      },
      deliver: async () => {},
    });
  });
  afterEach(() => {
    flushSync(() => root.unmount());
    pendingSends.dispose();
    container.remove();
  });

  it('shows the first frozen config even before the empty document hydrates', () => {
    enqueue();
    render({ documentReady: false });
    expect(visible()).toEqual({ model: 'chosen', mode: 'agent', effort: 'high', role: roleId });
    expect(baseline.sourceFence.currentTurnKey).toBe('turn:first');
  });

  it('bridges removal to history publication and preserves the next draft selection', async () => {
    enqueue();
    render();
    flushSync(() => selection.selectModel('next'));
    await settle();
    expect(pendingSends.hasSession(sessionId)).toBe(false);
    expect(visible().model).toBe('next');
    expect(baseline.hasPendingConfig).toBe(true);
    durable = [turn('first')];
    render();
    expect(baseline.hasPendingConfig).toBe(false);
    expect(visible().model).toBe('next');
    expect(durable[0]!.inputConfig?.modelId).toBe('chosen');
  });

  it('never flashes the default between a held send and its landed turn', async () => {
    enqueue();
    render();
    await settle();
    expect(visible().model).toBe('chosen');
    durable = [turn('first')];
    render();
    expect(baseline.hasPendingConfig).toBe(false);
    expect(visible().model).toBe('chosen');
  });

  it('takes a continuation config ahead of the previous turn runtime snapshot', async () => {
    durable = [turn('old', 'next')];
    render();
    expect(visible().model).toBe('default');
    enqueue();
    expect(visible().model).toBe('chosen');
    await settle();
    durable = [...durable, turn('first')];
    render();
    expect(visible().model).toBe('chosen');
  });

  it('keeps an explicit next-draft choice even when it equals the held model', async () => {
    enqueue();
    render();
    flushSync(() => selection.selectModel('chosen'));
    await settle();
    durable = [turn('first')];
    render();
    expect(selection.hasUserEdits).toBe(true);
    expect(visible().model).toBe('chosen');
  });

  it('keeps a failed send configuration and protects edits when it is canceled', async () => {
    enqueue();
    render();
    shouldFail = true;
    await settle();
    expect(visible().model).toBe('chosen');
    flushSync(() => selection.selectModel('next'));
    await act(async () => {
      await pendingSends.cancel('first');
    });
    expect(baseline.hasPendingConfig).toBe(false);
    expect(visible().model).toBe('next');
    expect(landed.size).toBe(0);
  });

  it('uses the last accepted local send and never imports another session config', () => {
    enqueue(turn('first'));
    enqueue(turn('second', 'next'));
    enqueue(turn('other', 'chosen'), otherSessionId);
    render();
    expect(visible().model).toBe('next');
    render({ currentSessionId: otherSessionId });
    expect(visible().model).toBe('chosen');
    render();
    expect(visible().model).toBe('next');
  });

  it('does not resurrect an old local baseline after a newer durable turn is removed', () => {
    enqueue();
    render();
    durable = [turn('remote', 'default')];
    render();
    expect(baseline.hasPendingConfig).toBe(false);
    durable = [];
    render();
    expect(visible().model).toBe('default');
  });
});

describe('existing-session run-config drafts across tabs', () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ReturnType<typeof createStore>;
  let selection: ReturnType<typeof useAcpSessionConfigSelectionState>;
  const options: AcpSessionSelectorOptionsInput = {
    capabilityAuthority: 'authoritative',
    modeOptions: [{ value: 'agent', label: 'Agent' }],
    modelOptions: [{ value: 'gpt-6', label: 'GPT-6' }],
    defaultModeId: 'agent',
    defaultModelId: 'gpt-6',
    modelReasoningEfforts: undefined,
    configOptionSelectors: [
      { configId: 'fast-mode', label: 'Fast', type: 'boolean', currentValue: false, options: [] },
    ],
  };
  function Harness({
    session = 'a',
    provider = 'codex-a',
    ready = true,
    revision = 'turn:old',
    preferred = false,
    runtime = false,
  }: {
    session?: string;
    provider?: string;
    ready?: boolean;
    revision?: string;
    preferred?: boolean;
    runtime?: boolean;
  }) {
    selection = useAcpSessionConfigSelectionState({
      enabled: ready,
      targetKey: `builtin:codex:${provider}`,
      preferenceRevision: revision,
      preferences: { configOptionValues: { 'fast-mode': preferred } },
      runtimePreferences: { configOptionValues: { 'fast-mode': runtime } },
      preserveUnsentUserEdits: true,
      draftScope: {
        accountId: 'account',
        workspaceId: 'workspace',
        sessionId: session,
        targetKey: `builtin:codex:${provider}`,
      },
    });
    const resolved = useResolvedAcpSessionConfigSelection(selection.selection, options);
    return <output>{String(resolved.configOptionValues['fast-mode'])}</output>;
  }
  const render = (props: Parameters<typeof Harness>[0] = {}, remount = false) => {
    flushSync(() =>
      root.render(
        <Provider store={store}>
          <Harness key={remount ? (props.session ?? 'a') : 'same'} {...props} />
        </Provider>
      )
    );
  };
  const toggle = (value: boolean) =>
    flushSync(() => selection.selectConfigOption('fast-mode', value));
  const visible = () => container.textContent;
  const capture = () => selection.captureForSend({ configOptionValues: { 'fast-mode': true } });
  beforeEach(() => {
    store = createStore();
    store.set(setSessionRunConfigDraftAccountAtom, 'account');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
  });

  it.each([false, true])('keeps Fast on through A/B/A with remount=%s', (remount) => {
    render({}, remount);
    toggle(true);
    render({ session: 'b' }, remount);
    expect(visible()).toBe('false');
    render({ session: 'a' }, remount);
    expect(visible()).toBe('true');
  });
  it('keeps explicit Fast off and isolates edits in both tabs', () => {
    render({ runtime: true }, true);
    toggle(false);
    render({ session: 'b' }, true);
    toggle(true);
    render({ session: 'a', runtime: true }, true);
    expect(visible()).toBe('false');
    render({ session: 'b' }, true);
    expect(visible()).toBe('true');
  });
  it('isolates provider drafts and restores the same target without reviving its old callbacks', () => {
    render();
    toggle(true);
    const editA = selection.selectConfigOption;
    render({ provider: 'codex-b' });
    expect(visible()).toBe('false');
    flushSync(() => editA('fast-mode', false));
    expect(selection.hasUserEdits).toBe(false);
    toggle(false);
    render();
    expect(visible()).toBe('true');
    render({ provider: 'codex-b', runtime: true });
    expect(visible()).toBe('false');
    expect(store.get(sessionRunConfigDraftsAtom).size).toBe(2);
  });
  it('does not consume a draft during hydration, remote turns, promotion or rollback', () => {
    render({}, true);
    toggle(true);
    render({ session: 'b' }, true);
    render({ ready: false, revision: '', preferred: true }, true);
    render({ revision: 'turn:remote', preferred: true }, true);
    expect(visible()).toBe('true');
    expect(selection.hasUserEdits).toBe(true);
    render({ revision: 'turn:old', runtime: false });
    expect(visible()).toBe('true');
    expect(selection.hasUserEdits).toBe(true);
  });
  it('acknowledges a local accepted send after unmount even if a newer remote turn arrived', () => {
    render({}, true);
    toggle(true);
    const accepted = capture();
    render({ session: 'b' }, true);
    flushSync(() => accepted?.());
    expect(store.get(sessionRunConfigDraftsAtom).size).toBe(0);
    render({ revision: 'turn:later-remote', preferred: false }, true);
    expect(visible()).toBe('false');
    expect(selection.hasUserEdits).toBe(false);
  });
  it.each([true, false])('does not erase the next draft value %s after acceptance', (next) => {
    render();
    toggle(true);
    const accepted = capture();
    toggle(next);
    flushSync(() => accepted?.());
    expect(visible()).toBe(String(next));
    expect(selection.hasUserEdits).toBe(true);
    render({ session: 'b' }, true);
    render({}, true);
    expect(visible()).toBe(String(next));
  });
  it('does not capture a newer same-valued edit through an older rendered send callback', () => {
    render();
    toggle(true);
    const oldCapture = selection.captureForSend;
    toggle(true);
    const accepted = oldCapture({ configOptionValues: { 'fast-mode': true } });
    flushSync(() => accepted?.());
    expect(visible()).toBe('true');
    expect(selection.hasUserEdits).toBe(true);
  });

  it('does not let an old edit callback write after its tab was replaced', () => {
    render();
    const selectA = selection.selectConfigOption;
    render({ session: 'b' });
    flushSync(() => selectA('fast-mode', true));
    expect(visible()).toBe('false');
    expect(store.get(sessionRunConfigDraftsAtom).size).toBe(0);
  });
  it('retains no drafts while visiting a thousand read-only sessions or turn revisions', async () => {
    for (let index = 0; index < 1000; index++)
      await act(async () => {
        render({ session: `readonly-${index}`, revision: `turn:${index}` });
      });
    expect(store.get(sessionRunConfigDraftsAtom).size).toBe(0);
    render();
    toggle(true);
    const draft = store.get(sessionRunConfigDraftsAtom);
    const callback = selection.selectConfigOption;
    for (let index = 0; index < 10; index++)
      render({ revision: `remote:${index}`, preferred: index % 2 === 0 });
    expect(store.get(sessionRunConfigDraftsAtom)).toBe(draft);
    expect(selection.selectConfigOption).toBe(callback);
  });
});

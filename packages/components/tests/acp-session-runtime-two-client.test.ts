import { LoroDoc } from 'loro-crdt';
import { Mirror } from 'loro-mirror';
import { describe, expect, it } from 'vitest';

import {
  resolveSessionAcpRuntimeConfig,
  sessionDocSchema,
  type SessionDoc,
  type SessionHistoryInput,
  type SessionId,
} from '@lody/shared';
import {
  EMPTY_ACP_SESSION_USER_CONFIG_EDITS,
  resolveAcpSessionConfigSelection,
  type AcpSessionConfigPreferences,
  type AcpSessionUserConfigEdits,
} from '../src/lib/acp-session-config-selection';

const userTurnId = 'turn-plan-low';
const sharedPlanLow: AcpSessionConfigPreferences = {
  configOptionValues: {
    collaboration_mode: 'plan',
    reasoning_effort: 'low',
  },
};
const selectors = [
  {
    configId: 'collaboration_mode',
    label: 'Collaboration mode',
    type: 'select' as const,
    currentValue: 'plan',
    options: [
      { value: 'default', label: 'Default' },
      { value: 'plan', label: 'Plan' },
    ],
  },
  {
    configId: 'reasoning_effort',
    label: 'Reasoning effort',
    type: 'select' as const,
    currentValue: 'low',
    options: [
      { value: 'low', label: 'Low' },
      { value: 'high', label: 'High' },
    ],
  },
];
const selectorOptions = {
  capabilityAuthority: 'authoritative' as const,
  modeOptions: [],
  modelOptions: [],
  defaultModeId: null,
  defaultModelId: null,
  configOptionSelectors: selectors,
};

const createUserTurn = (): SessionHistoryInput => ({
  id: userTurnId,
  role: 'user',
  items: [{ type: 'text', text: 'Make a plan.' }],
  timestamp: '2026-08-29T00:00:00.000Z',
  status: 'completed',
  read: true,
  userId: 'user-a',
  fileDiff: [],
  finished: true,
  inputConfig: {
    prompt: 'Make a plan.',
    cliType: 'builtin',
    agentType: 'codex',
    configOptionValues: sharedPlanLow.configOptionValues,
  },
});

const resolveComposerValues = (
  edits: AcpSessionUserConfigEdits,
  runtimePreferences: AcpSessionConfigPreferences | null
) =>
  resolveAcpSessionConfigSelection(
    { edits, preferences: sharedPlanLow, runtimePreferences },
    selectorOptions
  ).configOptionValues;

describe('ACP runtime config across two clients', () => {
  it("syncs Plan exit to both clients without publishing A's unsent High choice", () => {
    const docA = new LoroDoc();
    const mirrorA = new Mirror({
      doc: docA,
      schema: sessionDocSchema,
      initialState: {
        session: { id: 'session-1' as SessionId },
        history: [],
        mq: [],
      } satisfies Partial<SessionDoc>,
      throwOnValidationError: true,
    });
    mirrorA.setState((state) => ({ ...state, history: [createUserTurn()] }));

    const docB = new LoroDoc();
    docB.import(docA.export({ mode: 'snapshot' }));
    const mirrorB = new Mirror({
      doc: docB,
      schema: sessionDocSchema,
      throwOnValidationError: true,
    });

    // A holds an unsent High edit; B has none.
    const editsA: AcpSessionUserConfigEdits = { configOptions: { reasoning_effort: 'high' } };
    const editsB = EMPTY_ACP_SESSION_USER_CONFIG_EDITS;

    mirrorA.setState((state) => ({
      ...state,
      acpRuntimeConfig: {
        acpSessionId: 'acp-session-1',
        basedOnUserTurnId: userTurnId,
        revision: 1,
        configOptionValues: {
          collaboration_mode: 'default',
          reasoning_effort: 'low',
        },
      },
    }));
    docB.import(docA.export({ mode: 'update', from: docB.version() }));

    const stateA = mirrorA.getState();
    const stateB = mirrorB.getState();
    const runtimeA = resolveSessionAcpRuntimeConfig(
      stateA.history,
      stateA.mq,
      stateA.acpRuntimeConfig
    );
    const runtimeB = resolveSessionAcpRuntimeConfig(
      stateB.history,
      stateB.mq,
      stateB.acpRuntimeConfig
    );
    expect(runtimeA).toEqual(runtimeB);
    expect(runtimeB?.configOptionValues).toEqual({
      collaboration_mode: 'default',
      reasoning_effort: 'low',
    });

    expect(resolveComposerValues(editsA, runtimeA)).toEqual({
      collaboration_mode: 'default',
      reasoning_effort: 'high',
    });
    expect(resolveComposerValues(editsB, runtimeB)).toEqual({
      collaboration_mode: 'default',
      reasoning_effort: 'low',
    });
    expect(mirrorB.getState().acpRuntimeConfig?.configOptionValues).toEqual({
      collaboration_mode: 'default',
      reasoning_effort: 'low',
    });

    mirrorA.dispose();
    mirrorB.dispose();
  });
});

import { LoroDoc } from 'loro-crdt';
import { Mirror } from 'loro-mirror';
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  resolveSessionAcpRuntimeConfig,
  ACP_CAPABILITY_CACHE_VERSION,
  sessionDocSchema,
  type SessionDoc,
  type SessionHistoryInput,
  type SessionId,
  type AgentConfigId,
  type MachineMeta,
  type AcpCommandSummary,
} from '@lody/shared';
import { useAvailableCommands } from '../src/hooks/use-available-commands';
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
  it('shows probe commands before startup, isolates projects, syncs actual commands and honors empty lists', () => {
    let preview: AcpCommandSummary[] = [{ name: 'help' }];
    const project = (id: string) => {
      const doc = new LoroDoc();
      const mirror = new Mirror({
        doc,
        schema: sessionDocSchema,
        throwOnValidationError: true,
        initialState: { session: { id: id as SessionId }, history: [], mq: [] },
      });
      return { doc, mirror };
    };
    const a = project('project-a');
    const b = project('project-b');
    const reader = project('project-a-reader');
    const menu = (mirror: typeof a.mirror) => {
      function Menu() {
        const commands = useAvailableCommands(
          {
            configId: 'provider' as AgentConfigId,
            cliType: 'builtin',
            agentType: 'pi',
            machine: {
              acpCapabilities: {
                provider: {
                  cliType: 'builtin',
                  agentType: 'pi',
                  cacheVersion: ACP_CAPABILITY_CACHE_VERSION,
                  modes: [],
                  models: [],
                  fetchedAt: 1,
                  availableCommands: preview,
                },
              },
            } as unknown as MachineMeta,
          },
          mirror.getState().acpRuntimeConfig?.availableCommands
        );
        return createElement('span', null, commands.map((command) => command.name).join(','));
      }
      return renderToStaticMarkup(createElement(Menu));
    };
    const publish = (mirror: typeof a.mirror, names: string[]) =>
      mirror.setState((state) => ({
        ...state,
        acpRuntimeConfig: {
          acpSessionId: 'native',
          basedOnUserTurnId: 'turn-1',
          revision: 1,
          availableCommands: names.map((name) => ({ name })),
        },
      }));
    expect(menu(a.mirror)).toBe('<span>help</span>');
    publish(a.mirror, ['review-a']);
    publish(b.mirror, ['review-b']);
    expect(menu(a.mirror)).toBe('<span>review-a</span>');
    expect(menu(b.mirror)).toBe('<span>review-b</span>');
    preview = [{ name: 'refreshed-help' }];
    expect(menu(a.mirror)).toBe('<span>review-a</span>');
    expect(menu(b.mirror)).toBe('<span>review-b</span>');
    expect(menu(reader.mirror)).toBe('<span>refreshed-help</span>');
    reader.doc.import(a.doc.export({ mode: 'snapshot' }));
    expect(menu(reader.mirror)).toBe('<span>review-a</span>');
    publish(a.mirror, []);
    reader.doc.import(a.doc.export({ mode: 'update', from: reader.doc.version() }));
    expect(menu(a.mirror)).toBe('<span></span>');
    expect(menu(reader.mirror)).toBe('<span></span>');
    expect(menu(b.mirror)).toBe('<span>review-b</span>');
    for (const { mirror } of [a, b, reader]) mirror.dispose();
  });

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
        acpSessionId: 'acp-session-1', generation: 'connection-1', state: 'ready',
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
    const runtimeA = resolveSessionAcpRuntimeConfig(stateA.acpRuntimeConfig);
    const runtimeB = resolveSessionAcpRuntimeConfig(stateB.acpRuntimeConfig);
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

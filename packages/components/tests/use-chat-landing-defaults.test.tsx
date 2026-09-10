// @vitest-environment jsdom

import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentConfigId, MachineId } from '@lody/shared';
import type { AcpSelectorOptions } from '../src/components/shared/acp-selector-options';
import {
  useAcpSessionConfigSelectionState,
  useResolvedAcpSessionConfigSelection,
} from '../src/hooks/use-acp-session-config-selection';
import { useChatLandingDefaults } from '../src/hooks/use-chat-landing-defaults';
import { writeChatLandingDefaults } from '../src/lib/chat-landing-defaults';
import { agentDefaultsCache, persistAgentSessionDefaults } from '../src/lib/local-storage-cache';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const machineId = 'machine-1' as MachineId;
const agentId = 'agent-a' as AgentConfigId;

const selectorOptions = (
  authority: AcpSelectorOptions['capabilityAuthority'],
  models: string[],
  defaultModelId: string | null
): AcpSelectorOptions => ({
  capabilityAuthority: authority,
  modeOptions: [],
  modelOptions: models.map((value) => ({ value, label: value })),
  defaultModeId: null,
  defaultModelId,
  configOptionSelectors: [],
});

function DefaultsProbe({ options }: { options: AcpSelectorOptions }) {
  const controller = useAcpSessionConfigSelectionState({
    targetKey: `${machineId}:${agentId}`,
    preferenceRevision: agentId,
    preferences: agentDefaultsCache.get(agentId) ?? {},
  });
  const resolved = useResolvedAcpSessionConfigSelection(controller.selection, options);

  return (
    <>
      <output data-model={resolved.selectedModelId ?? ''} />
      <button type="button" onClick={() => controller.selectModel('gpt-5.5')}>
        Select 5.5
      </button>
    </>
  );
}

describe('chat landing agent session defaults', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('does not let provisional static options invalidate a saved model', () => {
    persistAgentSessionDefaults(agentId, { modelId: 'gpt-5.6-sol' });

    act(() => {
      root.render(
        <DefaultsProbe options={selectorOptions('provisional', ['gpt-5.5'], 'gpt-5.5')} />
      );
    });
    expect(container.querySelector('output')?.dataset.model).toBe('gpt-5.6-sol');

    act(() => {
      root.render(
        <DefaultsProbe
          options={selectorOptions('authoritative', ['gpt-5.6-sol', 'gpt-5.5'], 'gpt-5.6-sol')}
        />
      );
    });
    expect(container.querySelector('output')?.dataset.model).toBe('gpt-5.6-sol');
  });

  it('preserves a user selection made before runtime capabilities arrive', () => {
    persistAgentSessionDefaults(agentId, { modelId: 'gpt-5.6-sol' });
    act(() => {
      root.render(
        <DefaultsProbe options={selectorOptions('provisional', ['gpt-5.5'], 'gpt-5.5')} />
      );
    });
    act(() => {
      container.querySelector('button')?.click();
    });

    act(() => {
      root.render(
        <DefaultsProbe
          options={selectorOptions('authoritative', ['gpt-5.6-sol', 'gpt-5.5'], 'gpt-5.6-sol')}
        />
      );
    });
    expect(container.querySelector('output')?.dataset.model).toBe('gpt-5.5');
  });
});

/* The #185 oscillation regression (session 51e236e0…) lives in
   tests/session-config-selection-oscillation.test.tsx. */

describe('contextType restore vs auto-switch (write ping-pong regression)', () => {
  let renderCount = 0;
  let lastContextType: 'local' | 'github' | 'chat' = 'chat';
  const noop = () => {};

  /* Chat landing in miniature: the defaults hook restores the stored
     contextType while the sibling auto-switch effect moves a context whose
     backing collection is empty. The two writers run under DIFFERENT
     readiness guards, and `contextType` is a dep of the restore effect — so a
     restore that re-writes on every pre-init run ping-pongs with the
     auto-switch unboundedly (React #185). The restore must be ONE-SHOT per
     workspace entry: after it, the auto-switch rules own the field. */
  function ContextTypeProbe() {
    renderCount += 1;
    const [contextType, setContextType] = useState<'local' | 'github' | 'chat'>('chat');
    const hasLocalProjects = false;
    useEffect(() => {
      if (contextType === 'local' && !hasLocalProjects) {
        setContextType('github');
      }
    }, [contextType, hasLocalProjects]);
    useChatLandingDefaults({
      workspaceId: 'ws-oscillation',
      shouldRestoreContextType: true,
      contextType,
      setContextType,
      executorConfigs: [],
      machines: new Map(),
      selectableMachines: new Map(),
      // Keeps the load effect un-latched (a stored agent that cannot resolve
      // while doc meta is not ready) — the exact window the loop lived in.
      visibleMachinesLoading: true,
      docMetaCacheReady: false,
      repositories: [],
      selectedAgent: null,
      setSelectedAgent: noop,
      selectedMachineId: null,
      selectedRepo: undefined,
      setSelectedRepo: noop,
      selectedBranch: null,
      setSelectedBranch: noop,
      selectedLocalProject: null,
      setSelectedLocalProject: noop,
      selectedLocalBranch: null,
      setSelectedLocalBranch: noop,
    });
    lastContextType = contextType;
    return null;
  }

  it('restores once and lets the auto-switch settle instead of ping-ponging', () => {
    localStorage.clear();
    writeChatLandingDefaults('ws-oscillation', { contextType: 'local', agentId: 'agent-1' });
    renderCount = 0;
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    expect(() => {
      act(() => {
        root.render(<ContextTypeProbe />);
      });
    }).not.toThrow();
    // restore 'local' (once) → auto-switch 'github' → settled.
    expect(lastContextType).toBe('github');
    expect(renderCount).toBeLessThanOrEqual(6);
    act(() => root.unmount());
    container.remove();
  });
});

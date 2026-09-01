// @vitest-environment jsdom

import { act, useMemo } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentConfigId, MachineId } from '@lody/shared';
import type { AcpSelectorOptions } from '../src/components/shared/acp-selector-options';
import {
  useAcpSessionConfigSelectionState,
  useResolvedAcpSessionConfigSelection,
} from '../src/hooks/use-acp-session-config-selection';
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

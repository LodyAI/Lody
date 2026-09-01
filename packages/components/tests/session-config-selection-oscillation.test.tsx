// @vitest-environment jsdom

import { act, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import type { AgentConfigId, MachineId } from '@lody/shared';
import type { AcpSelectorOptions } from '../src/components/shared/acp-selector-options';
import {
  useAcpSessionConfigSelectionState,
  useResolvedAcpSessionConfigSelection,
} from '../src/hooks/use-acp-session-config-selection';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const machineId = 'machine-1' as MachineId;
const agentId = 'agent-claude' as AgentConfigId;

/* Production wiring in miniature, with the REAL data of session 51e236e0…
   (decoded from its local Loro doc): the last turn's preferences carry `fast`,
   the agent's runtime config snapshot does not, and the capability options are
   REBUILT from the selection every render (useSessionAcpSelectorContext).
   Under the old reconcile/apply layout-effect pair this exact shape looped —
   reconcile re-seeded `fast`, apply-runtime deleted it, the options' identity
   churn re-armed the effect — and crashed the renderer with React #185
   ("Maximum update depth exceeded") the moment the session opened on 0.89.x.
   The derived hook stores only user edits and feeds options from CANDIDATES,
   so this must mount and settle in one pass. */
function OscillationProbe({ authority }: { authority: AcpSelectorOptions['capabilityAuthority'] }) {
  const controller = useAcpSessionConfigSelectionState({
    targetKey: `${machineId}:${agentId}`,
    preferenceRevision: 'turn-1',
    preferences: {
      modeId: 'auto',
      modelId: 'claude-fable-5[1m]',
      configOptionValues: { effort: 'high', fast: false },
    },
    runtimePreferences: {
      modeId: 'auto',
      modelId: 'claude-fable-5',
      configOptionValues: { effort: 'high', mode: 'auto', model: 'claude-fable-5' },
    },
    preserveUnsentUserEdits: true,
  });
  const options = useMemo<AcpSelectorOptions>(() => {
    const enrich = (values: string[], candidate: string | null) =>
      candidate && !values.includes(candidate) ? [...values, candidate] : values;
    return {
      capabilityAuthority: authority,
      modeOptions: enrich(['auto'], controller.candidates.modeId).map((value) => ({
        value,
        label: value,
      })),
      modelOptions: enrich(['claude-fable-5'], controller.candidates.modelId).map((value) => ({
        value,
        label: value,
      })),
      defaultModeId: 'auto',
      defaultModelId: 'claude-fable-5',
      configOptionSelectors: [
        {
          configId: 'effort',
          label: 'Effort',
          type: 'select',
          currentValue: 'default',
          options: [
            { value: 'default', label: 'D' },
            { value: 'high', label: 'H' },
          ],
        },
        { configId: 'fast', label: 'Fast', type: 'boolean', currentValue: false, options: [] },
      ],
    };
  }, [authority, controller.candidates.modeId, controller.candidates.modelId]);
  const resolved = useResolvedAcpSessionConfigSelection(controller.selection, options);
  return (
    <output
      data-model={resolved.selectedModelId ?? ''}
      data-mode={resolved.selectedModeId ?? ''}
      data-effort={String(resolved.configOptionValues.effort ?? '')}
    />
  );
}

describe('session config selection oscillation (#185 regression, session 51e236e0…)', () => {
  it.each(['provisional', 'authoritative'] as const)(
    'mounts and settles under %s capabilities instead of exceeding the update depth',
    (authority) => {
      const container = document.createElement('div');
      document.body.append(container);
      const root = createRoot(container);
      act(() => {
        root.render(<OscillationProbe authority={authority} />);
      });
      const output = container.querySelector('output');
      // The runtime snapshot's values win; the stale `fast` preference is
      // settled once, not re-seeded/deleted forever.
      expect(output?.dataset.mode).toBe('auto');
      expect(output?.dataset.effort).toBe('high');
      if (authority === 'authoritative') {
        expect(output?.dataset.model).toBe('claude-fable-5');
      } else {
        // Provisional caps take the runtime baseline at its word.
        expect(output?.dataset.model).toBe('claude-fable-5');
      }
      act(() => root.unmount());
      container.remove();
    }
  );
});

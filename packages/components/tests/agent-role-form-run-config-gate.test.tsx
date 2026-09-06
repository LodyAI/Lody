// @vitest-environment jsdom

import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import type { AgentConfigId, MachineId } from '@lody/shared';

import { AgentRoleForm } from '../src/components/settings/agent-role-form';
import {
  EMPTY_AGENT_ROLE_FORM_VALUE,
  validateAgentRoleForm,
  type AgentRoleFormValue,
} from '../src/lib/agent-role-form';
import type { AcpSelectorOptions } from '../src/components/shared/acp-selector-options';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const namedValue = (overrides: Partial<AgentRoleFormValue> = {}): AgentRoleFormValue => ({
  ...EMPTY_AGENT_ROLE_FORM_VALUE,
  name: 'Reviewer',
  machineId: 'machine-1' as MachineId,
  agentConfigId: 'config-1' as AgentConfigId,
  ...overrides,
});

const selectorOptions = (authority: AcpSelectorOptions['capabilityAuthority']) =>
  ({
    capabilityAuthority: authority,
    modeOptions: [{ value: 'plan', label: 'Plan' }],
    modelOptions: [{ value: 'model-a', label: 'Model A' }],
    defaultModeId: 'plan',
    defaultModelId: 'model-a',
    configOptionSelectors: [],
  }) as unknown as AcpSelectorOptions;

describe('Agent Role run-config gate', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    await initI18n('en');
    vi.stubGlobal(
      'ResizeObserver',
      class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const render = (props: Parameters<typeof AgentRoleForm>[0]) =>
    act(() => root.render(createElement(AgentRoleForm, props)));

  const submitButton = () =>
    Array.from(container.querySelectorAll('button')).find(
      (button) => button.getAttribute('type') === 'submit'
    );

  it('refuses to create a Role while capabilities are unreported', () => {
    // The agent has not reported; the form shows no run-config controls, so the
    // user has chosen nothing. Saving would create a "complete configuration"
    // that pins no permission at all.
    const value = namedValue();
    const errors = validateAgentRoleForm(value, {
      accessibleRoles: [],
      capabilityAuthority: 'provisional',
    });
    expect(errors).toEqual(['run_config_unavailable']);

    render({
      value,
      onChange: () => undefined,
      machines: [{ machineId: 'machine-1' as MachineId, label: 'Mac' }],
      agentConfigs: [{ agentConfigId: 'config-1' as AgentConfigId, label: 'Codex' }],
      selectorOptions: selectorOptions('provisional'),
      issues: [],
      errors,
      onSubmit: () => undefined,
      onCancel: () => undefined,
    });

    expect(submitButton()?.disabled).toBe(true);
    // And the controls really are absent, so nothing renders as chosen.
    expect(container.textContent).toContain('has not reported its capabilities');
  });

  it('saves once the agent has reported', () => {
    const value = namedValue({ modeId: 'plan', modelId: 'model-a' });
    const errors = validateAgentRoleForm(value, {
      accessibleRoles: [],
      capabilityAuthority: 'authoritative',
    });
    expect(errors).toEqual([]);

    render({
      value,
      onChange: () => undefined,
      machines: [{ machineId: 'machine-1' as MachineId, label: 'Mac' }],
      agentConfigs: [{ agentConfigId: 'config-1' as AgentConfigId, label: 'Codex' }],
      selectorOptions: selectorOptions('authoritative'),
      issues: [],
      errors,
      onSubmit: () => undefined,
      onCancel: () => undefined,
    });

    expect(submitButton()?.disabled).toBe(false);
  });

  it('refuses a composer-seeded create too, non-empty though it is', () => {
    // Chat landing and the input area create a Role from what they currently
    // show, and under `provisional` capabilities those values are the static
    // tables' own defaults — nobody chose them. Emptiness cannot tell that from
    // a real selection, so creation itself is what is refused.
    expect(
      validateAgentRoleForm(
        namedValue({
          modeId: 'plan',
          modelId: 'model-a',
          configOptionValues: { 'fast-mode': true },
        }),
        { accessibleRoles: [], capabilityAuthority: 'provisional' }
      )
    ).toEqual(['run_config_unavailable']);
  });

  it('keeps an existing Role editable while its agent is unreachable', () => {
    // It already carries what it pins, so nothing is being invented here.
    expect(
      validateAgentRoleForm(namedValue({ modeId: 'plan', modelId: 'model-a' }), {
        accessibleRoles: [],
        capabilityAuthority: 'unavailable',
        isEditingExistingRole: true,
      })
    ).toEqual([]);
  });
});

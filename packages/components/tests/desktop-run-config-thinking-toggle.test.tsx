// @vitest-environment jsdom

import { act, createElement, type ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { type AgentConfigId, type AgentConfigMeta, type MachineId } from '@lody/shared';

vi.mock('../src/hooks/use-online-machines', () => ({ useOnlineMachines: () => [] }));

import { DesktopRunConfigMenu } from '../src/components/sessions/desktop-run-config-menu';
import type { AcpConfigOptionSelector } from '../src/components/shared/acp-selector-options';
import { initI18n } from '../src/i18n';
import { TooltipProvider } from '../src/ui/tooltip';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const machineId = 'machine-1' as MachineId;
const agentConfig: AgentConfigMeta = {
  id: 'config-cursor' as AgentConfigId,
  machineId,
  name: 'Cursor',
  description: undefined,
  cliType: 'registry',
  agentType: 'cursor',
  env: {},
};

const cursorSelectors: AcpConfigOptionSelector[] = [
  {
    type: 'select',
    configId: 'thinking',
    category: 'thought_level',
    label: 'Thinking',
    currentValue: 'true',
    options: [
      { value: 'true', label: 'On' },
      { value: 'false', label: 'Off' },
    ],
  },
  {
    type: 'select',
    configId: 'effort',
    category: 'thought_level',
    label: 'Effort',
    currentValue: 'low',
    options: [
      { value: 'low', label: 'Low' },
      { value: 'high', label: 'High' },
    ],
  },
  {
    type: 'select',
    configId: 'context',
    category: 'model_config',
    label: 'Context',
    currentValue: 'default',
    options: [{ value: 'default', label: 'Default' }],
  },
  {
    type: 'select',
    configId: 'fast',
    category: 'model_config',
    label: 'Fast',
    currentValue: 'false',
    options: [
      { value: 'true', label: 'On' },
      { value: 'false', label: 'Off' },
    ],
  },
];

type MenuProps = ComponentProps<typeof DesktopRunConfigMenu>;

const baseProps: MenuProps = {
  agentSelection: { agentId: agentConfig.id, machineId },
  availableAgentConfigs: [agentConfig],
  modelOptions: [
    { value: 'a', label: 'A' },
    { value: 'b', label: 'B' },
  ],
  selectedModelId: 'a',
  onModelChange: () => undefined,
  configOptionSelectors: cursorSelectors,
  configOptionValues: {
    thinking: 'true',
    effort: 'low',
    context: 'default',
    fast: 'false',
  },
  onConfigOptionChange: () => undefined,
};

describe('DesktopRunConfigMenu thinking toggle', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    await initI18n('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
      root = undefined;
    }
    container?.remove();
    container = undefined;
  });

  const render = async (props: Partial<MenuProps> = {}): Promise<HTMLDivElement> => {
    await act(async () => {
      root?.render(
        createElement(
          TooltipProvider,
          { delayDuration: 0 },
          createElement(DesktopRunConfigMenu, { ...baseProps, ...props })
        )
      );
    });
    return container as HTMLDivElement;
  };

  const openMenu = async (view: HTMLElement) => {
    await act(async () => {
      view
        .querySelector('button[aria-label="Run configuration"]')
        ?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    });
    return document.querySelector('[role="menu"]') as HTMLElement;
  };

  it('renders a Thinking checkbox that follows true and toggles to false', async () => {
    const onConfigOptionChange = vi.fn();
    const view = await render({ onConfigOptionChange });
    const menu = await openMenu(view);

    const thinkingRow = [...menu.querySelectorAll('[role="menuitemcheckbox"]')].find((node) =>
      node.textContent?.includes('Thinking')
    );
    expect(thinkingRow).toBeDefined();
    expect(thinkingRow?.getAttribute('aria-checked')).toBe('true');

    const reasoningRow = [...menu.querySelectorAll('[role="menuitem"]')].find((node) =>
      node.textContent?.trim().startsWith('Reasoning')
    );
    expect(reasoningRow?.textContent).toContain('Low');
    expect(reasoningRow?.textContent).not.toContain('On');

    await act(async () => {
      (thinkingRow as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onConfigOptionChange).toHaveBeenCalledWith('thinking', 'false');
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
  });
});

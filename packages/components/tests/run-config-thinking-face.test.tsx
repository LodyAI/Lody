// @vitest-environment jsdom

import { act, createElement, type ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import {
  AGENT_ROLE_VERSION,
  type AgentConfigId,
  type AgentConfigMeta,
  type AgentRole,
  type AgentRoleId,
  type MachineId,
} from '@lody/shared';

vi.mock('../src/hooks/use-online-machines', () => ({ useOnlineMachines: () => [] }));

import { DesktopRunConfigMenu } from '../src/components/sessions/desktop-run-config-menu';
import { MobileRunConfigButton } from '../src/components/mobile/mobile-run-config-button';
import type { AcpConfigOptionSelector } from '../src/components/shared/acp-selector-options';
import type { ComposerAgentRoleItem } from '../src/lib/composer-agent-roles';
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
    currentValue: 'false',
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
];

const role: AgentRole = {
  v: AGENT_ROLE_VERSION,
  id: 'role-1' as AgentRoleId,
  ownerUserId: 'user-1',
  visibility: 'private',
  name: 'Code Reviewer',
  emoji: '🔍',
  machineId,
  agentConfigId: agentConfig.id,
  runConfig: { modelId: 'a', configOptionValues: { thinking: 'true' } },
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
};

const roleItem: ComposerAgentRoleItem = {
  role,
  availability: { kind: 'available' },
  agentConfig,
};

type MenuProps = ComponentProps<typeof DesktopRunConfigMenu>;

const desktopProps: MenuProps = {
  agentSelection: { agentId: agentConfig.id, machineId },
  availableAgentConfigs: [agentConfig],
  modelOptions: [{ value: 'a', label: 'A' }],
  selectedModelId: 'a',
  onModelChange: () => undefined,
  configOptionSelectors: cursorSelectors,
  configOptionValues: { thinking: 'true', effort: 'low' },
  onConfigOptionChange: () => undefined,
};

describe('run-config thinking face', () => {
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

  it('shows the desktop Brain mark when thinking is true and hides it when false', async () => {
    await act(async () => {
      root?.render(
        createElement(
          TooltipProvider,
          { delayDuration: 0 },
          createElement(DesktopRunConfigMenu, desktopProps)
        )
      );
    });
    const onTrigger = container?.querySelector('button[aria-label="Run configuration"]');
    expect(onTrigger?.querySelector('.lucide-brain')).not.toBeNull();

    await act(async () => {
      root?.render(
        createElement(
          TooltipProvider,
          { delayDuration: 0 },
          createElement(DesktopRunConfigMenu, {
            ...desktopProps,
            configOptionValues: { thinking: 'false', effort: 'low' },
          })
        )
      );
    });
    const offTrigger = container?.querySelector('button[aria-label="Run configuration"]');
    expect(offTrigger?.querySelector('.lucide-brain')).toBeNull();
  });

  it('keeps the desktop Brain mark on the Role inert face, not inside the trigger', async () => {
    await act(async () => {
      root?.render(
        createElement(
          TooltipProvider,
          { delayDuration: 0 },
          createElement(DesktopRunConfigMenu, {
            ...desktopProps,
            agentRoles: { items: [roleItem], selectedRoleId: role.id, onSelect: () => undefined },
          })
        )
      );
    });
    const trigger = container?.querySelector('button[aria-label="Run configuration"]');
    expect(trigger?.textContent).toContain('Code Reviewer');
    expect(trigger?.querySelector('.lucide-brain')).toBeNull();
    expect(container?.querySelector('.lucide-brain')).not.toBeNull();
    expect(container?.querySelector('.lucide-brain')?.closest('button')).toBeNull();
  });

  it('shows the mobile Brain mark when thinking is on', async () => {
    await act(async () => {
      root?.render(
        createElement(MobileRunConfigButton, {
          modelOptions: [{ value: 'a', label: 'A' }],
          selectedModelId: 'a',
          modeOptions: [],
          selectedModeId: null,
          configOptionSelectors: cursorSelectors,
          configOptionValues: { thinking: 'true', effort: 'low' },
        })
      );
    });
    const button = container?.querySelector('button[aria-label="Run configuration"]');
    expect(button?.querySelector('.lucide-brain')).not.toBeNull();

    await act(async () => {
      root?.render(
        createElement(MobileRunConfigButton, {
          modelOptions: [{ value: 'a', label: 'A' }],
          selectedModelId: 'a',
          modeOptions: [],
          selectedModeId: null,
          configOptionSelectors: cursorSelectors,
          configOptionValues: { thinking: 'false', effort: 'low' },
        })
      );
    });
    const off = container?.querySelector('button[aria-label="Run configuration"]');
    expect(off?.querySelector('.lucide-brain')).toBeNull();
  });
});

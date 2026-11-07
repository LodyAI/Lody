// @vitest-environment jsdom

// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import {
  AGENT_ROLE_VERSION,
  type AgentConfigId,
  type AgentConfigMeta,
  type AgentRole,
  type AgentRoleId,
  type MachineId,
} from '@lody/shared';

import { AgentRoleDetailPane } from '../src/components/sessions/agent-role-detail-pane';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const agentConfig: Pick<AgentConfigMeta, 'cliType' | 'agentType' | 'brandId' | 'env' | 'name'> = {
  cliType: 'builtin',
  agentType: 'codex',
  env: {},
  name: 'Codex',
};

const role = (overrides: Partial<AgentRole> = {}): AgentRole => ({
  v: AGENT_ROLE_VERSION,
  id: 'role-1' as AgentRoleId,
  ownerUserId: 'user-1',
  visibility: 'workspace',
  name: 'Code Reviewer',
  emoji: '🔍',
  machineId: 'machine-1' as MachineId,
  agentConfigId: 'config-1' as AgentConfigId,
  runConfig: { modelId: 'gpt-5.6-sol' },
  revision: 2,
  createdAt: 1,
  updatedAt: 2,
  ...overrides,
});

type PaneProps = ComponentProps<typeof AgentRoleDetailPane>;

describe('AgentRoleDetailPane', () => {
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

  const render = async (props: Partial<PaneProps> = {}): Promise<HTMLDivElement> => {
    await act(async () => {
      root?.render(createElement(AgentRoleDetailPane, { role: role(), agentConfig, ...props }));
    });
    return container as HTMLDivElement;
  };

  const rowValue = (view: HTMLDivElement, label: string): string | undefined => {
    const term = Array.from(view.querySelectorAll('dt')).find(
      (element) => element.textContent === label
    );
    return term?.parentElement?.querySelector('dd')?.textContent ?? undefined;
  };

  it('reads a pinned permission mode as the mode control, not as reasoning', async () => {
    // `runConfig.modeId` is the legacy ACP PERMISSION mode. The mention menu's
    // own rows used to print it under "Reasoning", which is what sent this pane
    // to both surfaces. Its label follows what the control IS — Codex's knob is
    // a mode selector, so the row is named "Mode", not "Permission".
    const view = await render({
      role: role({ runConfig: { modelId: 'gpt-5.6-sol', modeId: 'bypassPermissions' } }),
    });
    expect(rowValue(view, 'Mode')).toBe('bypassPermissions');
    expect(rowValue(view, 'Reasoning')).toBeUndefined();
    expect(rowValue(view, 'Permission')).toBeUndefined();
  });

  it('marks the retired model pin so the fix is obvious', async () => {
    const retired = await render({
      availability: { kind: 'unavailable', reason: 'model_unavailable' },
    });
    expect(retired.querySelector('dd')?.className).toContain('text-status-warning');
    const fine = await render({ availability: { kind: 'available' } });
    expect(fine.querySelector('dd')?.className).not.toContain('text-status-warning');
  });
});

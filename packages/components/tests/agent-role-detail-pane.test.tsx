// @vitest-environment jsdom

import { act, createElement, type ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import {
  ACP_CAPABILITY_CACHE_VERSION,
  AGENT_ROLE_VERSION,
  type AgentConfigId,
  type AgentConfigMeta,
  type AgentRole,
  type AgentRoleId,
  type MachineId,
  type MachineViewMeta,
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

  it('reads a pinned permission mode as permission, not as reasoning', async () => {
    // `runConfig.modeId` is the legacy ACP PERMISSION mode. The mention menu's
    // own rows used to print it under "Reasoning", which is what sent this pane
    // to both surfaces.
    const view = await render({
      role: role({ runConfig: { modelId: 'gpt-5.6-sol', modeId: 'bypassPermissions' } }),
    });
    expect(rowValue(view, 'Permission')).toBe('bypassPermissions');
    expect(rowValue(view, 'Reasoning')).toBeUndefined();
  });

  it('states only what the Role pins, never the agent current value', async () => {
    const view = await render();
    // The bound agent's own wording for the stored id, not the id.
    expect(rowValue(view, 'Model')).toBe('5.6-Sol');
    // This Role pins no reasoning level, so the pane must not borrow one from
    // the bound agent's own defaults and present it as the Role's.
    expect(rowValue(view, 'Reasoning')).toBeUndefined();
    expect(rowValue(view, 'Permission')).toBeUndefined();
  });

  it('keeps the provider visible for a pinned model', async () => {
    const machine = {
      acpCapabilities: {
        'config-1': {
          cliType: 'builtin',
          agentType: 'codex',
          cacheVersion: ACP_CAPABILITY_CACHE_VERSION,
          provenance: 'runtime',
          modes: [],
          models: [],
          configOptions: [
            {
              id: 'model',
              name: 'Model',
              category: 'model',
              type: 'select',
              currentValue: 'gpt-5.6-sol',
              options: [
                {
                  value: 'gpt-5.6-sol',
                  name: 'GPT-5.6-Sol',
                  provider: 'OpenAI',
                },
              ],
            },
          ],
          fetchedAt: 1,
        },
      },
    } as Pick<MachineViewMeta, 'acpCapabilities'>;

    const view = await render({ machine });
    expect(rowValue(view, 'Model')).toBe('5.6-Sol · OpenAI');
  });

  it('names the machine only where the surface passes one', async () => {
    const withMachine = await render({ machineLabel: 'Studio' });
    expect(withMachine.textContent).toContain('Studio');
    // The composer lists one machine by construction, so naming it there would
    // be a constant that says nothing.
    const withoutMachine = await render({ machineLabel: undefined });
    expect(withoutMachine.textContent).not.toContain('Studio');
  });

  it('shows the instruction itself and offers editing only where it can be done', async () => {
    const view = await render({ role: role({ promptPrefix: 'Correctness before style.' }) });
    expect(view.textContent).toContain('Correctness before style.');
    expect(view.querySelector('button')).toBeNull();

    let edited: string | null = null;
    const editable = await render({
      role: role({ promptPrefix: 'Correctness before style.' }),
      onEdit: (roleId) => {
        edited = roleId;
      },
    });
    await act(async () => {
      editable.querySelector('button')?.click();
    });
    expect(edited).toBe('role-1');
  });
});

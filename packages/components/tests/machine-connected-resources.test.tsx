// @vitest-environment jsdom

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import type { AgentConfigId, AgentConfigMeta, MachineId } from '@lody/shared';
import { MachineConnectedResources } from '../src/components/settings/my-machine-connected-resources';
import { initI18n } from '../src/i18n';

const machineId = 'machine-shared' as MachineId;
const configs: AgentConfigMeta[] = [
  {
    id: 'config-codex' as AgentConfigId,
    machineId,
    name: 'Codex',
    description: undefined,
    cliType: 'builtin',
    agentType: 'codex',
    env: {},
  },
];

describe('MachineConnectedResources read-only inventory', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await initI18n('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = undefined;
    container?.remove();
    container = undefined;
    document.body.innerHTML = '';
  });

  it('shows shared machine metadata to teammates without owner controls', async () => {
    await act(async () => {
      root?.render(
        <MachineConnectedResources
          machineId={machineId}
          configs={configs}
          preloadedProjects={[
            {
              key: 'machine-shared:project-lody',
              name: 'lody',
              rootPath: '/Users/zixuan/Code/lody',
              sharedWithTeam: true,
            },
          ]}
          projectsLoading={false}
          readOnly
          onManageAgents={vi.fn()}
        />
      );
    });

    expect(container?.textContent).toContain('lody');
    expect(container?.textContent).toContain('Codex');
    expect(container?.querySelector('[role="switch"]')).toBeNull();
    expect(container?.textContent).not.toContain('Manage in Agents');
  });
});

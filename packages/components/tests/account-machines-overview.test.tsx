// @vitest-environment jsdom

import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachineId } from '@lody/shared';
import {
  AccountMachinesOverviewView,
  type AccountMachineOverviewItem,
} from '../src/components/settings/account-machines-overview';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const machineId = 'machine-one' as MachineId;
const items: AccountMachineOverviewItem[] = [
  {
    id: machineId,
    name: 'MacBook Pro',
    os: 'macOS',
    isOnline: true,
    sharedWithTeam: true,
    agents: [],
    directories: [
      {
        key: 'machine-one:project-one',
        name: 'lody',
        rootPath: '/Users/zixuan/Code/lody',
        sharedWithTeam: false,
      },
    ],
  },
];

describe('AccountMachinesOverviewView', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    await initI18n('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
  });

  it('opens the selected machine Agent configuration', async () => {
    const onConfigureAgents = vi.fn();
    await render({ onConfigureAgents });

    await act(async () => getButton('Configure').click());

    expect(onConfigureAgents).toHaveBeenCalledWith(machineId);
  });

  it('labels the current Electron machine next to its name', async () => {
    await render({ currentMachineId: machineId });

    const machineName = getButton('MacBook Pro');
    expect(machineName.parentElement?.textContent).toBe('MacBook ProThis machine');
  });

  it('does not label a machine without an Electron current-machine id', async () => {
    await render();

    expect(container?.textContent).not.toContain('This machine');
  });

  it('reveals connected directories and opens the selected project', async () => {
    const onOpenDirectory = vi.fn();
    await render({ onOpenDirectory });

    expect(container?.textContent).not.toContain('/Users/zixuan/Code/lody');
    await act(async () => getButton('1 directory').click());
    expect(container?.textContent).toContain('/Users/zixuan/Code/lody');

    await act(async () => getButton('lody').click());
    expect(onOpenDirectory).toHaveBeenCalledWith(machineId, 'machine-one:project-one');
  });

  async function render(
    overrides: Partial<ComponentProps<typeof AccountMachinesOverviewView>> = {}
  ) {
    await act(async () => {
      root?.render(
        <AccountMachinesOverviewView
          items={items}
          onConfigureAgents={() => undefined}
          onManageMachine={() => undefined}
          onOpenDirectory={() => undefined}
          onOpenDirectories={() => undefined}
          {...overrides}
        />
      );
    });
  }

  function getButton(name: string): HTMLButtonElement {
    const button = Array.from(container?.querySelectorAll('button') ?? []).find((element) =>
      element.textContent?.includes(name)
    );
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`Could not find button: ${name}`);
    }
    return button;
  }
});

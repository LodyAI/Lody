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
    document.body.innerHTML = '';
  });

  it('states each machine in one line under its name', async () => {
    await render({
      items: [
        items[0]!,
        {
          ...items[0]!,
          id: 'machine-two' as MachineId,
          name: 'Build box',
          os: 'Linux',
          isOnline: false,
          sharedWithTeam: false,
        },
      ],
    });

    expect(helpers()).toEqual([
      'Online · macOS · Shared · 0 Agents · 1 directory',
      'Offline · Linux · Private · 0 Agents · 1 directory',
    ]);
  });

  it('labels the current Electron machine in its status line', async () => {
    await render({ currentMachineId: machineId });

    expect(helpers()[0]).toBe('This machine · Online · macOS · Shared · 0 Agents · 1 directory');
  });

  it('does not label a machine without an Electron current-machine id', async () => {
    await render();

    expect(container?.textContent).not.toContain('This machine');
  });

  it('opens the machine settings from its one Manage button', async () => {
    const onManageMachine = vi.fn();
    await render({ onManageMachine });

    const buttons = Array.from(container?.querySelectorAll('section button') ?? []).filter(
      (button) => button.textContent === 'Manage'
    );
    expect(buttons).toHaveLength(1);
    await act(async () => (buttons[0] as HTMLButtonElement).click());

    expect(onManageMachine).toHaveBeenCalledWith(machineId);
  });

  async function render(
    overrides: Partial<ComponentProps<typeof AccountMachinesOverviewView>> = {}
  ) {
    await act(async () => {
      root?.render(
        <AccountMachinesOverviewView
          items={items}
          onManageMachine={() => undefined}
          {...overrides}
        />
      );
    });
  }

  /** Each machine row's one-line status, in row order. */
  function helpers(): string[] {
    return Array.from(container?.querySelectorAll('section p') ?? [])
      .map((element) => element.textContent ?? '')
      .filter((text) => text.includes(' · '));
  }
});

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

/** jsdom has no PointerEvent; Base UI reads `pointerType` to tell a mouse press apart. */
class TestPointerEvent extends MouseEvent {
  readonly pointerType: string;

  constructor(type: string, init: MouseEventInit & { pointerType?: string } = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? '';
  }
}

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
    vi.stubGlobal('PointerEvent', TestPointerEvent);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
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

  it('lists connected directories in a menu and opens the selected project', async () => {
    const onOpenDirectory = vi.fn();
    await render({ onOpenDirectory });

    expect(document.body.textContent).not.toContain('/Users/zixuan/Code/lody');
    await press(getButton('1 directory'));
    await vi.waitFor(() =>
      expect(getMenuItem('lody').textContent).toContain('/Users/zixuan/Code/lody')
    );

    await act(async () => getMenuItem('lody').click());
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

  /** The pointer pressing a control, in the order a browser delivers it. */
  async function press(element: HTMLElement) {
    await act(async () => {
      const init = { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' };
      element.dispatchEvent(new TestPointerEvent('pointerdown', init));
      element.dispatchEvent(new MouseEvent('mousedown', init));
      element.focus();
      element.dispatchEvent(new TestPointerEvent('pointerup', init));
      element.dispatchEvent(new MouseEvent('mouseup', init));
      element.click();
    });
  }

  function getMenuItem(name: string): HTMLElement {
    const item = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')
    ).find((element) => element.textContent?.includes(name));
    if (!item) throw new Error(`Could not find menu item: ${name}`);
    return item;
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

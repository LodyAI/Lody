// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MachineId } from '@lody/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DesktopMachineMenu,
  type DesktopMachineMenuOption,
} from '../src/components/sessions/desktop-run-config-menu';
import { TooltipProvider } from '../src/ui/tooltip';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback,
  }),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

class TestPointerEvent extends MouseEvent {
  readonly pointerType: string;

  constructor(type: string, init: MouseEventInit & { pointerType?: string } = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? '';
  }
}

const localMachineId = 'machine-local' as MachineId;
const remoteMachineId = 'machine-remote' as MachineId;
const options: DesktopMachineMenuOption[] = [
  { value: localMachineId, label: 'Laptop', isPrivate: true },
  { value: remoteMachineId, label: 'Build server' },
];

describe('DesktopMachineMenu local machine label', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.defineProperty(globalThis, 'PointerEvent', {
      configurable: true,
      value: TestPointerEvent,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = '';
  });

  async function renderMenu({
    value = localMachineId,
    visibleLocalMachineId = localMachineId,
  }: {
    value?: MachineId;
    visibleLocalMachineId?: MachineId | null;
  } = {}) {
    await act(async () => {
      root.render(
        <TooltipProvider>
          <DesktopMachineMenu
            value={value}
            visibleLocalMachineId={visibleLocalMachineId}
            options={options}
            onChange={vi.fn()}
          />
        </TooltipProvider>
      );
    });
  }

  async function openMenu() {
    const trigger = container.querySelector<HTMLButtonElement>('button');
    expect(trigger).toBeInstanceOf(HTMLButtonElement);
    await act(async () => {
      trigger?.dispatchEvent(
        new TestPointerEvent('pointerdown', {
          bubbles: true,
          button: 0,
          pointerType: 'mouse',
        })
      );
    });
  }

  function getMachineItem(label: string): HTMLElement {
    const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
      (menuItem) => menuItem.textContent?.includes(label)
    );
    expect(item).toBeInstanceOf(HTMLElement);
    return item!;
  }

  it('labels the local selection in both the trigger and option', async () => {
    await renderMenu();

    expect(container.querySelector('button')?.textContent).toContain('Local');
    await openMenu();
    expect(getMachineItem('Laptop').textContent).toContain('Local');
  });

  it('does not label a remote machine as local', async () => {
    await renderMenu({ value: remoteMachineId });

    expect(container.querySelector('button')?.textContent).not.toContain('Local');
    await openMenu();
    expect(getMachineItem('Build server').textContent).not.toContain('Local');
  });

  it('shows Private and Local together for the local private machine', async () => {
    await renderMenu();
    await openMenu();

    expect(getMachineItem('Laptop').textContent).toContain('Local');
    expect(getMachineItem('Laptop').textContent).toContain('Private');
  });

  it('shows no local label when the local probe is absent', async () => {
    await renderMenu({ visibleLocalMachineId: null });

    expect(container.querySelector('button')?.textContent).not.toContain('Local');
    await openMenu();
    expect(getMachineItem('Laptop').textContent).not.toContain('Local');
    expect(getMachineItem('Build server').textContent).not.toContain('Local');
  });
});

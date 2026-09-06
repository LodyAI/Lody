// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PathLaunchersSettings } from '../src/components/settings/path-launchers-setting';
import { initI18n } from '../src/i18n';
import {
  readStoredPathLauncherPreference,
  writeStoredPathLauncherPreference,
} from '../src/lib/session-path-launchers';

vi.mock('@posthog/react', () => ({
  usePostHog: () => null,
}));

const { probePathLaunchers } = vi.hoisted(() => ({ probePathLaunchers: vi.fn() }));
vi.mock('../src/lib/electron-ipc-client', () => ({
  getIpcServices: () => ({ app: { probePathLaunchers } }),
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

describe('PathLaunchersSettings', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    await initI18n('en');
    localStorage.clear();
    probePathLaunchers.mockReset().mockResolvedValue({ availableIds: ['vscode', 'cursor'] });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: window.innerWidth < 768,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    Object.defineProperty(globalThis, 'PointerEvent', {
      configurable: true,
      value: TestPointerEvent,
    });
    HTMLElement.prototype.scrollIntoView = vi.fn();
    HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = '';
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('renders the selected launcher as one compact select and keeps custom editing available', async () => {
    seedCustomLauncher();
    await renderSettings();

    const trigger = getSelectTrigger();
    expect(trigger.textContent).toContain('PhpStorm');
    expect(trigger.querySelector('svg, img')).not.toBeNull();
    expect(container.querySelectorAll('[role="combobox"]')).toHaveLength(1);
    expect(container.querySelector('[role="radiogroup"]')).toBeNull();
    expect(document.querySelector('button[aria-label="Edit"]')).toBeNull();

    await openSelect();
    const editButton = getButton('Edit');
    await act(async () => editButton.click());

    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Edit launcher');
    expect(getInput('path-launcher-name').value).toBe('PhpStorm');
    expect(getInput('path-launcher-command').value).toBe('open -a "PhpStorm" {path}');

    const deleteButton = getButton('Delete');
    expect(deleteButton.textContent).toBe('');
    expect(deleteButton.querySelector('svg')).not.toBeNull();
    await act(async () => deleteButton.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(getSelectTrigger().textContent).toContain('VS Code');
    expect(readStoredPathLauncherPreference()).toEqual({
      selectedLauncherId: 'vscode',
      customLaunchers: [],
    });
  });

  it('lists logo and name options with the custom action last', async () => {
    seedCustomLauncher();
    await renderSettings();
    await openSelect();

    const options = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
    const optionLabels = options.map((option) => option.textContent?.trim());
    expect(optionLabels).toContain('VS Code');
    expect(optionLabels).toContain('PhpStorm');
    expect(optionLabels.at(-1)).toBe('Custom launcher');
    expect(options.every((option) => option.querySelector('svg, img'))).toBe(true);

    await chooseOption('Cursor');
    expect(getSelectTrigger().textContent).toContain('Cursor');
    expect(readStoredPathLauncherPreference().selectedLauncherId).toBe('cursor');

    await openSelect();
    await chooseOption('Custom launcher');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Add custom launcher');
    expect(readStoredPathLauncherPreference().selectedLauncherId).toBe('cursor');
  });

  it('uses a bottom sheet for the custom launcher form on mobile', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    seedCustomLauncher();
    await renderSettings();
    await openSelect();
    await act(async () => getButton('Edit').click());

    const sheet = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(sheet).not.toBeNull();
    expect(sheet?.className).toContain('bottom-0');
    expect(sheet?.className).toContain('slide-in-from-bottom');
    expect(sheet?.textContent).toContain('Edit launcher');
  });

  it('filters uninstalled built-ins and refreshes availability when opening the menu', async () => {
    probePathLaunchers.mockResolvedValue({ availableIds: ['cursor'] });
    await renderSettings();
    expect(getSelectTrigger().textContent).toContain('Cursor');
    expect(readStoredPathLauncherPreference().selectedLauncherId).toBe('vscode');

    probePathLaunchers.mockResolvedValue({ availableIds: ['zed'] });
    await openSelect();
    const labels = Array.from(document.querySelectorAll('[role="option"]')).map(
      (option) => option.textContent
    );
    expect(labels).toContain('Zed');
    expect(labels).not.toContain('Cursor');
    expect(labels).not.toContain('VS Code');
  });

  it('does not display a fallback editor when the probe fails and still allows creation', async () => {
    probePathLaunchers.mockRejectedValue(new Error('Probe unavailable'));
    await renderSettings();
    expect(getSelectTrigger().textContent).not.toContain('VS Code');
    await openSelect();
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(1);
    await chooseOption('Custom launcher');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Add custom launcher');
  });

  async function renderSettings(): Promise<void> {
    await act(async () => {
      root.render(<PathLaunchersSettings isElectron platform="darwin" />);
    });
  }

  async function openSelect(): Promise<void> {
    await act(async () => {
      getSelectTrigger().dispatchEvent(
        new TestPointerEvent('pointerdown', {
          bubbles: true,
          button: 0,
          pointerType: 'mouse',
        })
      );
    });
  }

  async function chooseOption(name: string): Promise<void> {
    const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (item) => item.textContent?.includes(name)
    );
    if (!option) throw new Error(`Could not find option: ${name}`);
    await act(async () => {
      option.focus();
      option.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    });
  }

  function seedCustomLauncher(): void {
    writeStoredPathLauncherPreference({
      selectedLauncherId: 'custom:phpstorm',
      customLaunchers: [
        {
          id: 'phpstorm',
          label: 'PhpStorm',
          commandTemplate: 'open -a "PhpStorm" {path}',
        },
      ],
    });
  }

  function getSelectTrigger(): HTMLButtonElement {
    const trigger = container.querySelector<HTMLButtonElement>('[role="combobox"]');
    if (!trigger) throw new Error('Could not find launcher select');
    return trigger;
  }

  function getButton(name: string): HTMLButtonElement {
    const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
      (item) => item.getAttribute('aria-label') === name || item.textContent?.includes(name)
    );
    if (!button) throw new Error(`Could not find button: ${name}`);
    return button;
  }

  function getInput(id: string): HTMLInputElement {
    const input = document.getElementById(id);
    if (!(input instanceof HTMLInputElement)) throw new Error(`Could not find input: ${id}`);
    return input;
  }
});

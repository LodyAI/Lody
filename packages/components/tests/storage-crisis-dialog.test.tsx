// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageCrisisDialog } from '../src/components/storage-crisis-dialog';
import { enterStorageCrisis, resetStorageCrisisForTests } from '../src/lib/storage-crisis';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const dismissAll = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    dismiss: (...args: unknown[]) => dismissAll(...args),
  },
}));

const restartApp = vi.fn(async () => true);
const quitApp = vi.fn(async () => true);
let desktopShell = true;
vi.mock('../src/lib/app-restart', () => ({
  isDesktopAppShell: () => desktopShell,
  restartApp: () => restartApp(),
  quitApp: () => quitApp(),
}));

let container: HTMLDivElement;
let root: Root;

function render(): void {
  act(() => {
    root.render(<StorageCrisisDialog />);
  });
}

function findButton(label: RegExp): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((button) =>
    label.test(button.textContent ?? '')
  ) as HTMLButtonElement | undefined;
}

beforeEach(async () => {
  await initI18n();
  desktopShell = true;
  dismissAll.mockClear();
  restartApp.mockClear();
  quitApp.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetStorageCrisisForTests();
});

describe('StorageCrisisDialog', () => {
  it('renders nothing while local storage is healthy', () => {
    render();
    expect(container.textContent).toBe('');
  });

  it('takes over the screen and dismisses the toasts the failure already raised', () => {
    render();

    act(() => {
      enterStorageCrisis({
        kind: 'unavailable',
        operation: 'loadDoc',
        detail:
          "InvalidStateError: Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.",
      });
    });

    const dialog = container.querySelector('[role="alertdialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dismissAll).toHaveBeenCalledTimes(1);
  });

  it('states that a restart is required and keeps the raw engine text collapsed', () => {
    render();
    act(() => {
      enterStorageCrisis({
        kind: 'unavailable',
        operation: 'loadDoc',
        detail: "InvalidStateError: Failed to execute 'transaction' on 'IDBDatabase'.",
      });
    });

    expect(container.textContent).toMatch(/Free up disk space/i);
    expect(container.textContent).toMatch(/Restart Lody/);
    expect(container.textContent).toMatch(/only reopens in a new app process/i);
    // The cryptic Chromium string is what users were shown before; it stays
    // behind the technical-details toggle.
    expect(container.textContent).not.toMatch(/IDBDatabase/);

    act(() => {
      findButton(/Technical details/)?.click();
    });
    expect(container.textContent).toMatch(/IDBDatabase/);
  });

  it('restarts the desktop process rather than reloading the renderer', () => {
    render();
    act(() => {
      enterStorageCrisis({ kind: 'quota', operation: 'save', detail: 'QuotaExceededError' });
    });

    act(() => {
      findButton(/Restart Lody/)?.click();
    });

    expect(restartApp).toHaveBeenCalledTimes(1);
    expect(quitApp).not.toHaveBeenCalled();
    // Both actions are disabled while one is in flight, so a second click cannot
    // race a relaunch that is already underway.
    expect(findButton(/Quit Lody/)?.disabled).toBe(true);
  });

  it('quits on request', () => {
    render();
    act(() => {
      enterStorageCrisis({ kind: 'quota', operation: 'save', detail: 'QuotaExceededError' });
    });

    act(() => {
      findButton(/Quit Lody/)?.click();
    });

    expect(quitApp).toHaveBeenCalledTimes(1);
    expect(restartApp).not.toHaveBeenCalled();
  });

  it('offers a reload instead of a quit outside the desktop shell', () => {
    desktopShell = false;
    render();
    act(() => {
      enterStorageCrisis({ kind: 'quota', operation: 'save', detail: 'QuotaExceededError' });
    });

    expect(findButton(/Reload Lody/)).toBeDefined();
    expect(findButton(/Quit Lody/)).toBeUndefined();
    expect(container.textContent).toMatch(/only reopens on a fresh page load/i);
  });
});

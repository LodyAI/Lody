/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorBoundaryFallback } from '../src/components/error-boundary-fallback';
import { initI18n } from '../src/i18n';

const mocks = vi.hoisted(() => ({
  startHardReset: vi.fn(),
  reloadApp: vi.fn(),
}));

vi.mock('../src/lib/clear-local-cache', () => ({
  startHardReset: mocks.startHardReset,
  reloadApp: mocks.reloadApp,
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let writeText: ReturnType<typeof vi.fn>;

function crashError(): Error {
  const error = new TypeError('session.title is not a function');
  error.stack = 'TypeError: session.title is not a function\n    at Chat (chat.tsx:12:3)';
  return error;
}

function render(props: Partial<Parameters<typeof ErrorBoundaryFallback>[0]> = {}) {
  act(() => {
    root.render(
      <ErrorBoundaryFallback
        error={crashError()}
        resetErrorBoundary={() => {}}
        variant="page"
        componentStack={'\n    at Chat\n    at RootOutlet'}
        boundaryName="RootOutlet"
        {...props}
      />
    );
  });
}

function button(text: string): HTMLButtonElement {
  const found = Array.from(document.body.querySelectorAll('button')).find((element) =>
    element.textContent?.includes(text)
  );
  if (!found) {
    throw new Error(
      `No button containing "${text}". Buttons: ${Array.from(
        document.body.querySelectorAll('button')
      )
        .map((element) => element.textContent)
        .join(' | ')}`
    );
  }
  return found as HTMLButtonElement;
}

function click(element: HTMLElement) {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(async () => {
  await initI18n('en');
  mocks.startHardReset.mockClear();
  mocks.reloadApp.mockClear();
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('ErrorBoundaryFallback', () => {
  it('shows the real error text instead of a generic apology', () => {
    render();
    expect(container.textContent).toContain('TypeError: session.title is not a function');
  });

  it('copies the full report — error, boundary, stack, and component stack', async () => {
    render();
    click(button('Copy error details'));
    await act(async () => {});

    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = writeText.mock.calls[0]?.[0] as string;
    expect(copied).toContain('TypeError: session.title is not a function');
    expect(copied).toContain('Boundary: RootOutlet');
    expect(copied).toContain('Stack:');
    expect(copied).toContain('Component stack:');
    expect(copied).toContain('at RootOutlet');
    expect(container.textContent).toContain('Copied');
  });

  it('surfaces a blocked copy and reveals the details so the text stays selectable', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    // The `document.execCommand` fallback does not exist in jsdom either.
    render();
    click(button('Copy error details'));
    await act(async () => {});

    expect(container.textContent).toContain('Copying was blocked');
    expect(container.textContent).toContain('Component stack:');
  });

  it('reveals technical details on demand rather than dumping them by default', () => {
    render();
    expect(container.textContent).not.toContain('Component stack:');

    click(button('Technical details'));
    expect(container.textContent).toContain('Component stack:');
    expect(container.textContent).toContain('Boundary: RootOutlet');
  });

  it('never reloads or resets on its own — recovery needs a click', () => {
    const resetErrorBoundary = vi.fn();
    render({ resetErrorBoundary });

    expect(mocks.reloadApp).not.toHaveBeenCalled();
    expect(resetErrorBoundary).not.toHaveBeenCalled();

    click(button('Try again'));
    expect(resetErrorBoundary).toHaveBeenCalledTimes(1);

    click(button('Reload Lody'));
    expect(mocks.reloadApp).toHaveBeenCalledTimes(1);
  });

  it('requires a confirmation before clearing local data and signing out', () => {
    render();

    click(button('Clear all local data and sign out'));
    expect(mocks.startHardReset).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Clear all local data and sign out?');

    click(button('Clear and sign out'));
    expect(mocks.startHardReset).toHaveBeenCalledTimes(1);
    // The dialog stays up in a progress state while the wipe + reload runs.
    expect(document.body.textContent).toContain('Clearing…');
  });

  it('lets the user cancel the wipe from the confirmation', () => {
    render();

    click(button('Clear all local data and sign out'));
    click(button('Cancel'));

    expect(mocks.startHardReset).not.toHaveBeenCalled();
  });

  it('keeps a raw backend payload out of the default view but inside the copy', async () => {
    const convexError = new Error(
      '[CONVEX Q(localProjects:list)] Server Error\n  Called by client'
    );
    render({ error: convexError, componentStack: null });

    expect(container.textContent).not.toContain('CONVEX');
    expect(container.textContent).not.toContain('Server Error');
    expect(container.textContent).toContain('The Lody backend returned a server error.');

    click(button('Copy error details'));
    await act(async () => {});
    expect(writeText.mock.calls[0]?.[0]).toContain('[CONVEX Q(localProjects:list)]');
  });

  it('keeps the inline variant to one readable line with retry and copy', () => {
    render({ variant: 'inline' });

    expect(container.textContent).toContain('TypeError: session.title is not a function');
    expect(container.querySelectorAll('button')).toHaveLength(2);
    expect(container.textContent).not.toContain('Clear all local data');
  });
});

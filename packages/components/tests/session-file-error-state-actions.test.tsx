// @vitest-environment jsdom

// The error card is the last thing a user sees for a file Lody will not render,
// so its ways out must appear exactly where they can work: copying the path on
// every platform, handing the file to the OS only on the desktop app with the
// file on this machine, and neither on an error opening the file cannot fix.

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SessionFileErrorState,
  offersFileActions,
} from '../src/components/sessions/session-file-error-state';
import type { SessionFileErrorActions } from '../src/lib/session-file-actions';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('session file error actions', () => {
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

  const render = async (
    props: Parameters<typeof SessionFileErrorState>[0]
  ): Promise<HTMLDivElement> => {
    await act(async () => {
      root?.render(createElement(SessionFileErrorState, props));
    });
    return container as HTMLDivElement;
  };

  const button = (view: HTMLDivElement, name: string) =>
    view.querySelector<HTMLButtonElement>(`[data-testid="session-file-error-${name}"]`);

  const localActions = (): SessionFileErrorActions & {
    onCopyPath: ReturnType<typeof vi.fn>;
  } => ({
    onCopyPath: vi.fn(),
    localHost: {
      openTarget: 'default-app',
      revealLabel: 'Show in Finder',
      onOpen: vi.fn(),
      onReveal: vi.fn(),
    },
  });

  it('offers every way out for a too-large file that lives on this machine', async () => {
    const fileActions = localActions();
    const view = await render({ message: 'Text too large', reason: 'text-too-large', fileActions });

    expect(button(view, 'open')?.textContent).toContain('Open in default app');
    // The reveal label travels with the actions because it is OS-specific.
    expect(button(view, 'reveal')?.textContent).toContain('Show in Finder');
    expect(button(view, 'copy-path')?.textContent).toContain('Copy file path');

    await act(async () => {
      button(view, 'open')?.click();
      button(view, 'reveal')?.click();
      button(view, 'copy-path')?.click();
    });
    expect(fileActions.localHost?.onOpen).toHaveBeenCalledTimes(1);
    expect(fileActions.localHost?.onReveal).toHaveBeenCalledTimes(1);
    expect(fileActions.onCopyPath).toHaveBeenCalledTimes(1);
  });

  it('names the browser when the OS default handler really is one', async () => {
    const view = await render({
      message: 'Text too large',
      reason: 'text-too-large',
      fileActions: {
        onCopyPath: vi.fn(),
        localHost: {
          openTarget: 'browser',
          revealLabel: 'Show in Finder',
          onOpen: vi.fn(),
          onReveal: vi.fn(),
        },
      },
    });
    expect(button(view, 'open')?.textContent).toContain('Open in browser');
  });

  it('keeps only the path for a file this client cannot touch', async () => {
    // A browser tab, or a session whose machine is not this one: the path is
    // still the answer, but nothing here can hand the file to an OS.
    const view = await render({
      message: 'Text too large',
      reason: 'text-too-large',
      fileActions: { onCopyPath: vi.fn() },
    });
    expect(button(view, 'copy-path')).not.toBeNull();
    expect(button(view, 'open')).toBeNull();
    expect(button(view, 'reveal')).toBeNull();
  });

  it('hides every action on an error that opening the file cannot resolve', async () => {
    const view = await render({
      message: 'File not found',
      reason: 'deleted',
      fileActions: localActions(),
    });
    expect(button(view, 'copy-path')).toBeNull();
    expect(button(view, 'open')).toBeNull();

    expect(offersFileActions('not-found')).toBe(false);
    expect(offersFileActions('temporarily-unavailable')).toBe(false);
    expect(offersFileActions('too-large')).toBe(true);
    expect(offersFileActions('unsupported')).toBe(true);
  });

  it('renders no action row when the caller has no path to offer', async () => {
    const view = await render({ message: 'Text too large', reason: 'text-too-large' });
    expect(button(view, 'copy-path')).toBeNull();
  });
});

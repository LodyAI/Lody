// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionId, SessionMeta } from '@lody/shared';

import {
  experimentalFeaturesEnabledAtom,
  reviewAgentExperimentEnabledAtom,
} from '../src/atoms/settings';
import { SessionHeaderMenu } from '../src/components/sessions/session-chat-interface';

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

const session = {
  id: 'session-menu-test',
  machineId: 'machine-menu-test',
  userId: 'user-menu-test',
  createdAt: '2026-07-29T00:00:00.000Z',
  title: 'Menu test',
} as SessionMeta;

const translate = (_key: string, fallback: string) => fallback;

describe('SessionHeaderMenu', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

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
    if (root) {
      await act(async () => root?.unmount());
    }
    document.body.innerHTML = '';
    root = undefined;
    container = undefined;
  });

  async function openMenu(): Promise<void> {
    const trigger = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="More actions"]'
    );
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

  it('forks from the action immediately above Rename Chat', async () => {
    const onFork = vi.fn();
    await act(async () => {
      root?.render(
        <SessionHeaderMenu
          session={session}
          onCopyUrl={vi.fn()}
          onOpenSearch={vi.fn()}
          onFork={onFork}
          onRename={vi.fn()}
          t={translate}
        />
      );
    });
    await openMenu();

    const menuItems = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    const labels = menuItems.map((item) => item.textContent?.trim());
    expect(labels.indexOf('Fork session')).toBe(labels.indexOf('Rename Chat') - 1);

    const forkItem = menuItems.find((item) => item.textContent?.includes('Fork session'));
    await act(async () => forkItem?.click());
    expect(onFork).toHaveBeenCalledTimes(1);
    expect(onFork).toHaveBeenCalledWith('shared');
  });

  it('turns the fork action into a submenu when a worktree destination is available', async () => {
    const onFork = vi.fn();
    await act(async () => {
      root?.render(
        <SessionHeaderMenu
          session={session}
          onCopyUrl={vi.fn()}
          onFork={onFork}
          forkWorktreeAvailability="available"
          t={translate}
        />
      );
    });
    await openMenu();

    const forkItem = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
      (item) => item.textContent?.includes('Fork session')
    );
    expect(forkItem?.getAttribute('aria-haspopup')).toBe('menu');
    await act(async () => forkItem?.click());
    expect(onFork).not.toHaveBeenCalled();
  });

  it('keeps the fork action visible but disabled while the request is pending', async () => {
    const onFork = vi.fn();
    await act(async () => {
      root?.render(
        <SessionHeaderMenu
          session={session}
          onCopyUrl={vi.fn()}
          onFork={onFork}
          isForking
          onRename={vi.fn()}
          t={translate}
        />
      );
    });
    await openMenu();

    const forkItem = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
      (item) => item.textContent?.includes('Fork session')
    );
    expect(forkItem?.getAttribute('data-disabled')).not.toBeNull();

    await act(async () => forkItem?.click());
    expect(onFork).not.toHaveBeenCalled();
  });

  it('shows dangling opened-by provenance without a navigation action', async () => {
    const onOpenSession = vi.fn();
    await act(async () => {
      root?.render(
        <SessionHeaderMenu
          session={session}
          onCopyUrl={vi.fn()}
          openedByRelations={{
            openedBy: {
              sessionId: 'deleted-opener' as SessionId,
              title: 'Deleted session',
              target: null,
            },
            opened: [],
            onOpenSession,
          }}
          t={translate}
        />
      );
    });
    await openMenu();

    const openedByItem = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
      (item) => item.textContent?.includes('Opened by: Deleted session')
    );
    expect(openedByItem?.getAttribute('data-disabled')).not.toBeNull();

    await act(async () => openedByItem?.click());
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it('keeps the reviewer setup dialog mounted after the actions menu closes', async () => {
    const store = createStore();
    store.set(experimentalFeaturesEnabledAtom, true);
    store.set(reviewAgentExperimentEnabledAtom, true);
    const onOpenReviewSettings = vi.fn();

    await act(async () => {
      root?.render(
        <Provider store={store}>
          <SessionHeaderMenu
            session={session}
            machineName="Review machine"
            onCopyUrl={vi.fn()}
            onOpenReviewSettings={onOpenReviewSettings}
            t={translate}
          />
        </Provider>
      );
    });
    await openMenu();

    const reviewItem = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
      (item) => item.textContent?.includes('Review this branch')
    );
    expect(reviewItem).toBeDefined();
    await act(async () => reviewItem?.click());

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.textContent).toContain('Configure a review agent');

    const openSettings = Array.from(
      dialog?.querySelectorAll<HTMLButtonElement>('button') ?? []
    ).find((button) => button.textContent?.includes('Open review settings'));
    await act(async () => openSettings?.click());
    expect(onOpenReviewSettings).toHaveBeenCalledTimes(1);
  });
});

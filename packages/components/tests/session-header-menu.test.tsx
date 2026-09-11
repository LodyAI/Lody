// @vitest-environment jsdom

import { act, useState, type ComponentProps } from 'react';
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

  function ForkMenuHarness({
    nativeForkAvailable = true,
    ...props
  }: Partial<ComponentProps<typeof SessionHeaderMenu>> & { nativeForkAvailable?: boolean }) {
    const [destination, setDestination] = useState('none');
    const [copied, setCopied] = useState(false);
    return (
      <>
        <SessionHeaderMenu
          session={session}
          onCopyUrl={() => {}}
          onRename={() => {}}
          onFork={nativeForkAvailable ? (target) => setDestination(target ?? 'shared') : undefined}
          onCopyConversationHistory={() => setCopied(true)}
          t={translate}
          {...props}
        />
        <output data-testid="fork-result">{destination}</output>
        <output data-testid="copy-result">{copied ? 'copied' : 'not copied'}</output>
      </>
    );
  }

  function menuItem(label: string): HTMLElement {
    const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
      (candidate) => candidate.textContent?.includes(label)
    );
    expect(item, label).toBeDefined();
    return item!;
  }

  async function openForkMenu(): Promise<void> {
    await openMenu();
    const trigger = menuItem('Fork session');
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    await act(async () => trigger.click());
    expect(container?.querySelector('[data-testid="fork-result"]')?.textContent).toBe('none');
  }

  it('opens the submenu and forks into the current workspace', async () => {
    await act(async () => root?.render(<ForkMenuHarness />));
    await openForkMenu();
    expect(menuItem('Copy context as Markdown')).toBeDefined();
    await act(async () => menuItem('Current workspace').click());
    expect(container?.querySelector('[data-testid="fork-result"]')?.textContent).toBe('shared');
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('forks into a new worktree when that destination is available', async () => {
    await act(async () => root?.render(<ForkMenuHarness forkWorktreeAvailability="available" />));
    await openForkMenu();
    await act(async () => menuItem('New worktree').click());
    expect(container?.querySelector('[data-testid="fork-result"]')?.textContent).toBe(
      'new-worktree'
    );
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('disables native destinations while pending but still allows copying', async () => {
    await act(async () =>
      root?.render(<ForkMenuHarness isForking forkWorktreeAvailability="available" />)
    );
    await openForkMenu();
    for (const label of ['Current workspace', 'New worktree']) {
      const item = menuItem(label);
      expect(item.getAttribute('data-disabled')).not.toBeNull();
      await act(async () => item.click());
      expect(container?.querySelector('[data-testid="fork-result"]')?.textContent).toBe('none');
    }
    const copyItem = menuItem('Copy context as Markdown');
    expect(copyItem.getAttribute('data-disabled')).toBeNull();
    await act(async () => copyItem.click());
    expect(container?.querySelector('[data-testid="copy-result"]')?.textContent).toBe('copied');
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('keeps copying available without native fork support', async () => {
    await act(async () => root?.render(<ForkMenuHarness nativeForkAvailable={false} />));
    await openForkMenu();
    expect(document.body.textContent).not.toContain('Current workspace');
    await act(async () => menuItem('Copy context as Markdown').click());
    expect(container?.querySelector('[data-testid="copy-result"]')?.textContent).toBe('copied');
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

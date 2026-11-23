// @vitest-environment jsdom
import { workspaceContentModeAtom } from '../src/atoms/workspace-content-mode';
import { initI18n } from '../src/i18n';

import { act, useState, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionId, SessionMeta } from '@lody/shared';

import { experimentalFeaturesEnabledAtom } from '../src/atoms/settings';
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

const translate = (_key: string, fallback: string, options?: Record<string, unknown>) =>
  Object.entries(options ?? {}).reduce(
    (message, [name, value]) => message.replaceAll(`{{${name}}}`, String(value)),
    fallback
  );

const vscodeLauncher = { kind: 'builtin' as const, id: 'vscode' as const, label: 'VS Code' };
const cursorLauncher = { kind: 'builtin' as const, id: 'cursor' as const, label: 'Cursor' };

describe('SessionHeaderMenu', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    await initI18n('en');
    vi.useFakeTimers();
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
    vi.useRealTimers();
    document.body.innerHTML = '';
    root = undefined;
    container = undefined;
  });

  async function openMenu(): Promise<void> {
    const trigger = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="More actions"]'
    );
    expect(trigger).toBeInstanceOf(HTMLButtonElement);
    await pressTrigger(trigger!);
  }

  async function pressTrigger(trigger: HTMLElement): Promise<void> {
    await act(async () => {
      trigger?.dispatchEvent(
        new TestPointerEvent('mousedown', {
          bubbles: true,
          button: 0,
          detail: 1,
          pointerType: 'mouse',
        })
      );
      await vi.advanceTimersByTimeAsync(40);
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
    const item = Array.from(document.querySelectorAll<HTMLElement>('[role^="menuitem"]')).find(
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

  async function openInfoDialog(menuOpen = false): Promise<HTMLElement> {
    if (!menuOpen) await openMenu();
    await act(async () => menuItem('Session info').click());
    const dialog = document.querySelector<HTMLElement>('[data-testid="session-info-dialog"]');
    expect(dialog).toBeInstanceOf(HTMLElement);
    return dialog!;
  }

  it('lists where the session lives in the info dialog instead of menu rows', async () => {
    const onOpenPr = vi.fn();
    await act(async () =>
      root?.render(
        <SessionHeaderMenu
          session={{
            ...session,
            project: { kind: 'github', repoFullName: 'acme/widgets', branch: 'main' },
            repoFullName: 'acme/widgets',
            baseBranch: 'main',
            branchName: 'feat/menu',
          }}
          workspacePath="/work/widgets"
          machineName="build-box"
          pullRequest={{ number: 42, status: 'open', onOpen: onOpenPr }}
          sharing={{
            visibility: 'team',
            access: 'edit',
            canManage: true,
            machineId: session.machineId,
            localProjectId: null,
            machineName: 'build-box',
            projectName: null,
          }}
          onCopyUrl={() => {}}
          t={translate}
        />
      )
    );
    await openMenu();
    const menuText = document.querySelector('[role="menu"]')?.textContent ?? '';
    for (const hidden of [
      'acme/widgets',
      'feat/menu',
      'build-box',
      'Team can edit',
      'new window',
    ]) {
      expect(menuText).not.toContain(hidden);
    }

    const dialog = await openInfoDialog(true);
    for (const shown of [
      'acme/widgets',
      'feat/menu',
      'main',
      '#42',
      'build-box',
      '/work/widgets',
    ]) {
      expect(dialog.textContent).toContain(shown);
    }
    expect(dialog.textContent).toContain('Team can edit');
    const prButton = Array.from(dialog.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('#42')
    );
    await act(async () => prButton?.click());
    expect(onOpenPr).toHaveBeenCalledTimes(1);
  });

  it('lists the IDE launcher only while the header pill is hidden', async () => {
    let pillVisible = true;
    const openInIde = {
      options: [vscodeLauncher],
      selected: vscodeLauncher,
      onOpen: () => {},
      onSelect: () => {},
    };
    await act(async () =>
      root?.render(
        <SessionHeaderMenu
          session={session}
          onCopyUrl={() => {}}
          openInIde={openInIde}
          isLauncherPillVisible={() => pillVisible}
          t={translate}
        />
      )
    );
    await openMenu();
    expect(document.querySelector('[role="menu"]')?.textContent).not.toContain('Open in VS Code');
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await vi.advanceTimersByTimeAsync(40);
    });
    pillVisible = false;
    await openMenu();
    expect(menuItem('Open in VS Code')).toBeDefined();
  });

  it('keeps Open in Finder in the menu while the header pill is showing', async () => {
    const onOpenFolder = vi.fn();
    await act(async () =>
      root?.render(
        <SessionHeaderMenu
          session={session}
          onCopyUrl={() => {}}
          openInIde={{
            options: [vscodeLauncher],
            selected: vscodeLauncher,
            onOpen: () => {},
            onSelect: () => {},
          }}
          openInFileManager={{ label: 'Open in Finder', onOpen: onOpenFolder }}
          isLauncherPillVisible={() => true}
          t={translate}
        />
      )
    );
    await openMenu();
    expect(document.querySelector('[role="menu"]')?.textContent).not.toContain('Open in VS Code');
    await act(async () => menuItem('Open in Finder').click());
    expect(onOpenFolder).toHaveBeenCalledTimes(1);
  });

  it('disables owner candidates without machine access and keeps an accessible candidate selectable', async () => {
    let assigned = 'a';
    await act(async () =>
      root?.render(
        <SessionHeaderMenu
          session={session}
          onCopyUrl={() => {}}
          onRename={() => {}}
          t={translate}
          owner={{
            members: [
              { userId: 'a', name: 'Alice' },
              { userId: 'b', name: 'Bob' },
              { userId: 'c', name: 'Carol' },
            ],
            ownerUserId: 'a',
            getDisabledReason: (id) => (id === 'b' ? 'Machine is not shared' : null),
            onChangeOwner: (id) => {
              assigned = id;
            },
          }}
        />
      )
    );
    const dialog = await openInfoDialog();
    expect(dialog.textContent).toContain('Alice');
    const change = Array.from(dialog.querySelectorAll<HTMLElement>('button')).find(
      (button) => button.textContent === 'Change'
    );
    await pressTrigger(change!);
    const bob = menuItem('Bob');
    expect(bob.getAttribute('aria-disabled')).toBe('true');
    expect(bob.textContent).toContain('Machine is not shared');
    await act(async () => bob.click());
    expect(assigned).toBe('a');
    await act(async () => menuItem('Carol').click());
    expect(assigned).toBe('c');
  });

  it('disables native destinations while pending but still allows copying', async () => {
    await act(async () =>
      root?.render(<ForkMenuHarness isForking forkWorktreeAvailability="available" />)
    );
    await openForkMenu();
    for (const label of ['Fork to new tab', 'Fork to new worktree']) {
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
    expect(document.body.textContent).not.toContain('Fork to new tab');
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

    const openedByItem = Array.from(
      document.querySelectorAll<HTMLElement>('[role="menuitem"]')
    ).find((item) => item.textContent?.includes('Opened by: Deleted session'));
    expect(openedByItem?.getAttribute('data-disabled')).not.toBeNull();

    await act(async () => openedByItem?.click());
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it('offers Settle alongside Move to Focus for a snoozed (Later) session', async () => {
    const onSettle = vi.fn();
    const onMoveToFocus = vi.fn();
    await act(async () => {
      root?.render(
        <SessionHeaderMenu
          session={{ ...session, snoozedUntil: Date.now() + 60 * 60 * 1000 }}
          onCopyUrl={() => {}}
          onSettle={onSettle}
          onMoveToFocus={onMoveToFocus}
          t={translate}
        />
      );
    });
    await openMenu();
    await act(async () => menuItem('Change status').click());
    await act(async () => menuItem('Settle').click());
    expect(onSettle).toHaveBeenCalledTimes(1);
    await openMenu();
    await act(async () => menuItem('Change status').click());
    await act(async () => menuItem('Move to Focus').click());
    expect(onMoveToFocus).toHaveBeenCalledTimes(1);
  });

  it('omits retired review actions even with the old opt-in and session pointer', async () => {
    const store = createStore();
    store.set(experimentalFeaturesEnabledAtom, true);
    localStorage.setItem('lody-review-agent-enabled', 'true');
    try {
      await act(async () => {
        root?.render(
          <Provider store={store}>
            <SessionHeaderMenu
              session={{ ...session, autoReview: { runId: 'retired-review', t: 1 } }}
              onCopyUrl={() => {}}
              t={translate}
            />
          </Provider>
        );
      });
      await openMenu();
      expect(document.querySelector('[role="menu"]')).not.toBeNull();
      expect(document.body.textContent).toContain('Copy');
      expect(document.body.textContent).not.toContain('Review this branch');
      expect(document.body.textContent).not.toContain('Auto review and merge');
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    } finally {
      localStorage.removeItem('lody-review-agent-enabled');
    }
  });
  it('allows encrypted sharing, local export and preview while keeping unsupported operations restricted', async () => {
    let exported = false;
    let shareOpened = false;
    const store = createStore();
    store.set(workspaceContentModeAtom, {
      accountId: 'user',
      workspaceSlug: 'encrypted',
      workspaceId: 'workspace',
      descriptor: { contentMode: 'e2ee', contentModeVersion: 1 },
    } as never);
    await act(async () =>
      root?.render(
        <Provider store={store}>
          <ForkMenuHarness
            onOpenPublicShare={() => {
              shareOpened = true;
            }}
            onShareWithTeam={() => {
              throw new Error('must not share with team');
            }}
            sharing={{
              visibility: 'private',
              privateReason: 'machine',
              canManage: true,
              machineId: session.machineId,
              localProjectId: null,
              machineName: 'remote',
              projectName: null,
            }}
            onShareAsImage={() => {
              exported = true;
            }}
          />
        </Provider>
      )
    );
    await openMenu();
    for (const reason of ['Encrypted workspaces do not yet support remote machine operations.']) {
      const item = menuItem(reason);
      expect(item.getAttribute('aria-disabled')).toBe('true');
      await act(async () => item.click());
    }
    expect(document.body.textContent).not.toContain(
      'Encrypted workspaces do not yet support remote preview.'
    );
    expect(document.body.textContent).not.toContain(
      'Encrypted workspaces do not yet support sharing.'
    );
    await act(async () => menuItem('Share').click());
    await act(async () => menuItem('Public link').click());
    expect(shareOpened).toBe(true);
    await openMenu();
    expect(container?.querySelector('[data-testid="copy-result"]')?.textContent).toBe('not copied');
    expect(container?.querySelector('[data-testid="fork-result"]')?.textContent).toBe('none');
    await act(async () => menuItem('Fork session').click());
    await act(async () => menuItem('Copy context as Markdown').click());
    expect(container?.querySelector('[data-testid="copy-result"]')?.textContent).toBe('copied');
    expect(container?.querySelector('[data-testid="fork-result"]')?.textContent).toBe('none');
    await openMenu();
    await act(async () => menuItem('Share').click());
    await act(async () => menuItem('Share as image').click());
    expect(exported).toBe(true);
  });
});

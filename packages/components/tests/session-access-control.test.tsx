// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { LocalProjectId, MachineId } from '@lody/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SessionAccessControl,
  type SessionShareEditorContext,
} from '../src/components/session-sharing';
import type { SessionPublicShareStatus, SessionSharingState } from '../src/lib/session-sharing';
import { Tooltip } from '@lody/ui/tooltip';

import { initI18n } from '../src/i18n';

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

const baseState = {
  canManage: true,
  machineId: 'machine-1' as MachineId,
  localProjectId: 'project-1' as LocalProjectId,
  machineName: 'Workstation',
  projectName: 'Lody',
};

describe('SessionAccessControl', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    await initI18n('en');
    Object.defineProperty(globalThis, 'PointerEvent', {
      configurable: true,
      value: TestPointerEvent,
    });
    // jsdom has none; the tab strip measures its indicator.
    globalThis.ResizeObserver ??= class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = '';
  });

  async function render(props: {
    state?: SessionSharingState;
    publicShare?: {
      status: SessionPublicShareStatus;
      renderEditor: (context: SessionShareEditorContext) => ReactNode;
    };
  }) {
    await act(async () => {
      root.render(
        <Tooltip.Provider>
          <SessionAccessControl {...props} onShareWithTeam={vi.fn()} />
        </Tooltip.Provider>
      );
    });
  }

  function trigger(): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>('button');
    expect(button).toBeInstanceOf(HTMLButtonElement);
    return button!;
  }

  async function openPanel(): Promise<void> {
    await act(async () => trigger().click());
  }

  function panel(): HTMLElement {
    const popup = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(popup).toBeInstanceOf(HTMLElement);
    return popup!;
  }

  function backButton(): HTMLButtonElement {
    const found = panel().querySelector<HTMLButtonElement>('button[aria-label="Back"]');
    expect(found).toBeInstanceOf(HTMLButtonElement);
    return found!;
  }

  function panelButton(label: string): HTMLButtonElement {
    const found = Array.from(panel().querySelectorAll<HTMLButtonElement>('button')).find(
      (candidate) => candidate.textContent === label
    );
    expect(found, label).toBeDefined();
    return found!;
  }

  /** What the page hands the panel: a stand-in editor that can report a publication under way. */
  const editorBody = (onBusyChange?: (busy: boolean) => void, onClose?: () => void) => (
    <div data-testid="editor">
      <button type="button" onClick={() => onBusyChange?.(true)}>
        Start publishing
      </button>
      <button type="button" onClick={() => onClose?.()}>
        Cancel editor
      </button>
    </div>
  );
  const renderEditor = () => <p>Editor body</p>;

  const privateState: SessionSharingState = {
    ...baseState,
    visibility: 'private',
    privateReason: 'project',
  };

  it.each([true, false])(
    'shows the immutable owner and personal recipients; can manage=%s',
    async (canManage) => {
      const granted = new Set(['reader']);
      const changes: string[] = [];
      const state: SessionSharingState = {
        ...baseState,
        visibility: 'private',
        access: 'read',
        canManage,
        ownerUserId: 'owner',
        memberUserIds: [...granted],
        availableMembers: [
          { userId: 'owner', name: 'Owner Alice' },
          { userId: 'reader', name: 'Reader Bob' },
          { userId: 'new', name: 'New Carol' },
        ],
        setMemberReadAccess: async (userId, shared) => {
          changes.push(userId);
          if (shared) granted.add(userId);
          else granted.delete(userId);
        },
      };
      await render({ state });
      expect(trigger().textContent).toContain('Shared with 1 person');
      await openPanel();
      expect(panel().textContent).toContain('Owner Alice');
      expect(panel().textContent).toContain('Reader Bob');
      expect(document.querySelector('button[aria-label="Remove Owner Alice"]')).toBeNull();
      const remove = document.querySelector<HTMLButtonElement>(
        'button[aria-label="Remove Reader Bob"]'
      );
      if (canManage) {
        expect(remove).not.toBeNull();
        await act(async () => remove!.click());
        expect([...granted]).toEqual([]);
        await act(async () => panelButton('Add member').click());
        const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
          (candidate) => candidate.textContent?.includes('New Carol')
        );
        expect(item).toBeDefined();
        expect(item!.querySelector('[data-size="mini"]')?.textContent).toBe('NC');
        await act(async () => item!.click());
        expect([...granted]).toEqual(['new']);
        expect(changes).toEqual(['reader', 'new']);
      } else {
        expect(remove).toBeNull();
        expect(
          [...panel().querySelectorAll('button')].some(
            (button) => button.textContent === 'Add member'
          )
        ).toBe(false);
        expect(changes).toEqual([]);
      }
    }
  );

  it('renders mini user avatars before candidate names with image and fallback support, preserving keyboard selection', async () => {
    const validPhoto =
      'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="16" height="16"%3E%3C/svg%3E';
    const brokenPhoto = 'data:image/svg+xml,broken';
    const originalImage = window.Image;
    class ControlledImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      referrerPolicy = '';
      crossOrigin: string | null = null;
      complete = false;
      naturalWidth = 0;
      private _src = '';
      get src() {
        return this._src;
      }
      set src(value: string) {
        this._src = value;
        if (value === validPhoto) {
          this.complete = true;
          this.naturalWidth = 16;
          this.onload?.();
        } else {
          this.complete = true;
          this.naturalWidth = 0;
          this.onerror?.();
        }
      }
    }
    Object.defineProperty(window, 'Image', {
      configurable: true,
      writable: true,
      value: ControlledImage,
    });
    vi.useFakeTimers({
      toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout'],
    });
    try {
      async function pressKey(key: string) {
        await act(async () => {
          document.activeElement!.dispatchEvent(
            new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
          );
        });
        // Base UI schedules menu focus on an animation frame.
        await act(async () => vi.advanceTimersToNextFrame());
      }

      const added: string[] = [];
      await render({
        state: {
          ...baseState,
          visibility: 'team',
          access: 'edit',
          canManage: true,
          ownerUserId: 'owner',
          memberUserIds: ['existing'],
          availableMembers: [
            { userId: 'owner', name: 'Owner Alice', image: validPhoto },
            { userId: 'existing', name: 'Existing Dave' },
            { userId: 'grace', name: 'Grace', image: validPhoto },
            { userId: 'marco', name: 'marco-dev', image: brokenPhoto },
            { userId: 'zoe', name: 'Zoe Chen', image: null },
          ],
          setMemberReadAccess: async (userId, shared) => {
            if (shared) added.push(userId);
          },
        },
      });
      await openPanel();
      await act(async () => panelButton('Add member').focus());
      await pressKey('ArrowDown');

      const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
      // Only candidates not already in the owner/member list are shown.
      expect(items).toHaveLength(3);

      const byName = (name: string) =>
        items.find((item) => item.lastElementChild?.textContent === name)!;

      // Candidate with loaded photo: mini avatar renders the candidate's image before the name.
      const grace = byName('Grace');
      expect(grace).toBeDefined();
      const graceAvatar = grace.querySelector<HTMLElement>('[data-size="mini"]');
      expect(graceAvatar).not.toBeNull();
      expect(graceAvatar!.closest('[aria-hidden="true"]')).not.toBeNull();
      const graceImg = graceAvatar!.querySelector<HTMLImageElement>('img');
      expect(graceImg).not.toBeNull();
      expect(graceImg!.getAttribute('src')).toBe(validPhoto);
      expect(
        Boolean(
          graceAvatar!.compareDocumentPosition(grace.lastElementChild!) &
          Node.DOCUMENT_POSITION_FOLLOWING
        )
      ).toBe(true);

      // Candidate with broken image falls back to existing UserAvatar initials.
      const marco = byName('marco-dev');
      expect(marco).toBeDefined();
      const marcoAvatar = marco.querySelector<HTMLElement>('[data-size="mini"]');
      expect(marcoAvatar).not.toBeNull();
      expect(marcoAvatar!.querySelector('img')).toBeNull();
      expect(marcoAvatar!.textContent).toBe('M');

      // Candidate without image renders existing UserAvatar initials before the name.
      const zoe = byName('Zoe Chen');
      expect(zoe).toBeDefined();
      const zoeAvatar = zoe.querySelector<HTMLElement>('[data-size="mini"]');
      expect(zoeAvatar).not.toBeNull();
      expect(zoeAvatar!.querySelector('img')).toBeNull();
      expect(zoeAvatar!.textContent).toBe('ZC');

      expect(document.activeElement).toBe(grace);
      await pressKey('ArrowDown');
      expect(document.activeElement).toBe(marco);
      await pressKey('z');
      await pressKey('o');
      expect(document.activeElement).toBe(zoe);
      await pressKey('Enter');
      expect(added).toEqual(['zoe']);
    } finally {
      vi.useRealTimers();
      Object.defineProperty(window, 'Image', {
        configurable: true,
        writable: true,
        value: originalImage,
      });
    }
  });

  it('retains cached candidates and team sharing controls when directory refresh fails, with a local retry', async () => {
    let retried = false;
    await render({
      state: {
        ...baseState,
        visibility: 'private',
        ownerUserId: 'owner',
        availableMembers: [
          { userId: 'owner', name: 'Alice' },
          { userId: 'candidate', name: 'Bob' },
        ],
        membersError: true,
        retryMembers: () => {
          retried = true;
        },
        setMemberReadAccess: async () => {},
        setReadAccess: async () => {},
      },
    });
    await openPanel();
    expect(panel().textContent).toContain('Member list could not be refreshed');
    expect(panel().textContent).toContain('Alice');
    expect(panelButton('Add member').disabled).toBe(false);
    await act(async () => panelButton('Retry').click());
    expect(retried).toBe(true);
    expect(panelButton('Add member').disabled).toBe(false);
  });

  it.each([
    ['en', true, 'Loading...'],
    ['en', false, 'Unknown member'],
    ['zh_CN', true, '加载中...'],
    ['zh_CN', false, '未知成员'],
  ] as const)(
    'uses localized member placeholders and keeps removal available (%s, loading=%s)',
    async (locale, loading, label) => {
      await initI18n(locale);
      let removed: string | undefined;
      await render({
        state: {
          ...baseState,
          visibility: 'private',
          ownerUserId: 'raw-owner-id',
          memberUserIds: ['raw-departed-id'],
          availableMembers: [],
          membersLoading: loading,
          setMemberReadAccess: async (id, shared) => {
            if (!shared) removed = id;
          },
        },
      });
      await openPanel();
      expect(panel().textContent).toContain(label);
      expect(panel().textContent).not.toContain('raw-owner-id');
      expect(panel().textContent).not.toContain('raw-departed-id');
      const remove = [...panel().querySelectorAll<HTMLButtonElement>('button[aria-label]')].find(
        (button) => button.getAttribute('aria-label')?.includes(label)
      );
      expect(remove).toBeDefined();
      expect(remove!.disabled).toBe(false);
      await act(async () => remove!.click());
      expect(removed).toBe('raw-departed-id');
    }
  );

  it.each(['team', 'unknown'] as const)(
    'shows the conversation state when visibility is %s without a public link',
    async (visibility) => {
      await render({ state: { ...baseState, visibility } });
      expect(trigger().textContent).toContain(
        visibility === 'team' ? 'Team can edit' : 'Checking visibility'
      );
    }
  );

  it('keeps publication open and disables Back while publishing', async () => {
    await render({
      state: privateState,
      publicShare: { status: 'none', renderEditor: ({ onBusyChange }) => editorBody(onBusyChange) },
    });
    await openPanel();
    await act(async () => panelButton('Publish to the web').click());
    await act(async () => panelButton('Start publishing').click());
    expect(backButton().disabled).toBe(true);
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('explains effective machine sharing and links to its settings without offering a private override', async () => {
    let opened = false;
    await render({
      state: {
        ...baseState,
        visibility: 'team',
        access: 'edit',
        openMachineSettings: () => {
          opened = true;
        },
      },
    });
    await openPanel();
    expect(panel().textContent).toContain('Team can edit · Controlled by machine sharing');
    expect(panelButton('Open machine settings')).toBeDefined();
    expect(panel().querySelector('[role=tab]')).toBeNull();
    await act(async () => panelButton('Open machine settings').click());
    expect(opened).toBe(true);
    expect(document.querySelector('[role=dialog]')).toBeNull();
  });

  it('omits machine settings when its callback is unavailable', async () => {
    await render({ state: { ...baseState, visibility: 'team', access: 'edit' } });
    await openPanel();
    expect(panel().textContent).toContain('Team can edit · Controlled by machine sharing');
    expect(panel().textContent).not.toContain('Open machine settings');
  });

  it('keeps public publication available in a solo workspace', async () => {
    await render({ publicShare: { status: 'none', renderEditor } });
    await openPanel();
    await act(async () => panelButton('Publish to the web').click());
    expect(panel().textContent).toContain('Editor body');
  });

  it('shows pending visibility without offering permission changes', async () => {
    await render({ state: { ...baseState, visibility: 'unknown' } });
    expect(trigger().textContent).toContain('Checking visibility');
    await openPanel();
    expect(panelButton('Private').getAttribute('aria-disabled')).toBe('true');
    expect(panelButton('Team read-only').getAttribute('aria-disabled')).toBe('true');
  });

  it('keeps team access independent of an unresolved or published public link', async () => {
    await render({ state: privateState, publicShare: { status: 'shared', renderEditor } });
    expect(trigger().textContent).toContain('Private');
    await openPanel();
    await act(async () => panelButton('Manage link').click());
    expect(panel().textContent).toContain('Editor body');
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  });

  it('disables both choices for a non-owner and explains the reason', async () => {
    await render({ state: { ...baseState, canManage: false, visibility: 'team', access: 'read' } });
    await openPanel();
    expect(panelButton('Private').getAttribute('aria-disabled')).toBe('true');
    expect(panelButton('Team read-only').getAttribute('aria-disabled')).toBe('true');
    expect(panel().textContent).toContain('Only the device owner can share');
    await act(async () => panelButton('Private').click());
    expect(trigger().textContent).toContain('Team read-only');
  });

  it('lets the owner grant and revoke one read-only conversation while the panel stays open', async () => {
    let state: SessionSharingState = {
      ...privateState,
      access: 'private',
      setReadAccess: async (level) => {
        state = {
          ...state,
          visibility: level === 'read' ? 'team' : 'private',
          access: level === 'read' ? 'read' : 'private',
        };
        await render({ state });
      },
    };
    await render({ state });
    await openPanel();
    await act(async () => panelButton('Team read-only').click());
    expect(trigger().textContent).toContain('Team read-only');
    expect(panelButton('Team read-only').getAttribute('aria-selected')).toBe('true');
    await act(async () => panelButton('Private').click());
    expect(trigger().textContent).toContain('Private');
    expect(panelButton('Private').getAttribute('aria-selected')).toBe('true');
  });
});

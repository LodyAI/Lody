// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { LocalProjectId, MachineId } from '@lody/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionAccessControl } from '../src/components/session-sharing';
import type { SessionPublicShareStatus, SessionSharingState } from '../src/lib/session-sharing';
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

  async function render(props: {
    state?: SessionSharingState;
    publicShare?: { status: SessionPublicShareStatus; onOpen: () => void };
  }) {
    await act(async () => {
      root.render(
        <TooltipProvider>
          <SessionAccessControl {...props} onShareWithTeam={vi.fn()} />
        </TooltipProvider>
      );
    });
  }

  function trigger(): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>('button');
    expect(button).toBeInstanceOf(HTMLButtonElement);
    return button!;
  }

  async function openMenu(): Promise<void> {
    await act(async () => {
      trigger().dispatchEvent(
        new TestPointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })
      );
    });
  }

  function menuItem(label: string): HTMLElement {
    const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
      (candidate) => candidate.textContent?.includes(label)
    );
    expect(item, label).toBeDefined();
    return item!;
  }

  it('renders the access control for a private conversation', async () => {
    await render({ state: { ...baseState, visibility: 'private', privateReason: 'project' } });

    expect(trigger().textContent).toContain('Private');
    expect(trigger().getAttribute('aria-label')).toContain('Private to you');
  });

  it.each(['team', 'unknown'] as const)(
    'renders nothing when visibility is %s and nothing can be published',
    async (visibility) => {
      await render({ state: { ...baseState, visibility } });

      expect(container.querySelector('button')).toBeNull();
      expect(container.textContent).toBe('');
    }
  );

  it('offers a direct share button when the conversation is not private', async () => {
    const onOpen = vi.fn();
    await render({
      state: { ...baseState, visibility: 'team' },
      publicShare: { status: 'none', onOpen },
    });

    expect(trigger().textContent).toContain('Share conversation');
    expect(trigger().getAttribute('aria-haspopup')).toBeNull();

    await act(async () => trigger().click());
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('offers the share button before any team visibility resolves', async () => {
    await render({ publicShare: { status: 'none', onOpen: vi.fn() } });

    expect(trigger().textContent).toContain('Share conversation');
  });

  it('reports a published conversation as shared without a menu', async () => {
    await render({
      state: { ...baseState, visibility: 'team' },
      publicShare: { status: 'shared', onOpen: vi.fn() },
    });

    expect(trigger().textContent).toContain('Shared');
    expect(trigger().textContent).not.toContain('Share conversation');
  });

  it('does not claim a conversation is shared before the status resolves', async () => {
    await render({
      state: { ...baseState, visibility: 'team' },
      publicShare: { status: 'unknown', onOpen: vi.fn() },
    });

    expect(trigger().textContent).toContain('Share conversation');
  });

  it('keeps publishing inside the menu of a private conversation', async () => {
    const onOpen = vi.fn();
    await render({
      state: { ...baseState, visibility: 'private', privateReason: 'project' },
      publicShare: { status: 'none', onOpen },
    });

    expect(trigger().textContent).toContain('Private');

    await openMenu();
    expect(menuItem('Share project with team…')).toBeDefined();
    await act(async () => menuItem('Share conversation').click());
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('reports a published private conversation as shared and still explains the private scope', async () => {
    await render({
      state: { ...baseState, visibility: 'private', privateReason: 'project' },
      publicShare: { status: 'shared', onOpen: vi.fn() },
    });

    expect(trigger().textContent).toContain('Shared');
    expect(trigger().getAttribute('aria-label')).toContain('Anyone with the link');

    await openMenu();
    const menu = document.querySelector<HTMLElement>('[role="menu"]');
    expect(menu?.textContent).toContain('Private to you');
    // The mocked translator does not interpolate, so assert the reason text
    // the private branch resolved rather than the project name it names.
    expect(menu?.textContent).toContain('is not shared with the team.');
  });
});

// @vitest-environment jsdom

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

  function stops(): HTMLElement[] {
    return Array.from(panel().querySelectorAll<HTMLElement>('[role="tab"]'));
  }

  function stop(label: string): HTMLElement {
    const found = stops().find((candidate) => candidate.textContent === label);
    expect(found, label).toBeDefined();
    return found!;
  }

  const isDisabled = (el: HTMLElement) =>
    el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';

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

  it.each(['team', 'unknown'] as const)(
    'renders nothing when visibility is %s and nothing can be published',
    async (visibility) => {
      await render({ state: { ...baseState, visibility } });

      expect(container.querySelector('button')).toBeNull();
      expect(container.textContent).toBe('');
    }
  );

  it('keeps the panel open and the way back disabled while a publication is under way', async () => {
    await render({
      state: privateState,
      publicShare: {
        status: 'none',
        renderEditor: ({ onBusyChange }) => editorBody(onBusyChange),
      },
    });

    await openPanel();
    await act(async () => stop('Web').click());
    await act(async () => panelButton('Start publishing').click());
    expect(backButton().disabled).toBe(true);

    // An outside press and Escape both ask to close; neither may dismiss it now.
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('marks the team for a team-visible conversation and never offers to narrow it', async () => {
    await render({
      state: { ...baseState, visibility: 'team' },
      publicShare: { status: 'none', renderEditor },
    });

    await openPanel();
    expect(panel().textContent).toContain('Shared with team');
    expect(stop('Team').getAttribute('aria-selected')).toBe('true');
    expect(isDisabled(stop('Only you'))).toBe(true);
  });

  it('reads a solo workspace as only you and still offers the web', async () => {
    await render({ publicShare: { status: 'none', renderEditor } });

    expect(trigger().textContent).toContain('Share');
    await openPanel();
    expect(panel().textContent).toContain('Private to you');
    expect(panel().textContent).not.toContain('Shared with team');
    expect(stops().map((el) => el.textContent)).toEqual(['Only you', 'Web']);
    expect(stop('Only you').getAttribute('aria-selected')).toBe('true');

    await act(async () => stop('Web').click());
    expect(panel().textContent).toContain('Editor body');
  });

  it('does not claim privacy while the visibility is still being resolved', async () => {
    await render({
      state: { ...baseState, visibility: 'unknown' },
      publicShare: { status: 'none', renderEditor },
    });

    await openPanel();
    expect(panel().textContent).toContain('Checking visibility…');
    // One audience is not a choice, so there is no strip to slide.
    expect(stops()).toHaveLength(0);
  });

  it('does not claim a conversation is shared before the status resolves', async () => {
    await render({
      state: { ...baseState, visibility: 'team' },
      publicShare: { status: 'unknown', renderEditor },
    });

    expect(trigger().textContent).toContain('Share');
    expect(trigger().textContent).not.toContain('Shared');
  });

  it('reads a published private conversation as web and offers to manage the link', async () => {
    await render({ state: privateState, publicShare: { status: 'shared', renderEditor } });

    expect(trigger().textContent).toContain('Shared');
    expect(trigger().getAttribute('aria-label')).toContain('Anyone with the link');

    await openPanel();
    expect(stop('Web').getAttribute('aria-selected')).toBe('true');
    await act(async () => panelButton('Manage link').click());
    expect(panel().textContent).toContain('Editor body');
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  });

  it('disables the team for someone who does not own the device and says why', async () => {
    await render({
      state: { ...baseState, canManage: false, visibility: 'private', privateReason: 'machine' },
      publicShare: { status: 'none', renderEditor },
    });

    await openPanel();
    expect(isDisabled(stop('Team'))).toBe(true);
    expect(panel().textContent).toContain('Only the device owner can share');
  });
});

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
    await render({ state: { ...baseState, visibility: 'team', access: 'edit' } });
    await openPanel();
    expect(panel().textContent).toContain('Team can edit · Controlled by machine sharing');
    expect(panelButton('Open machine settings')).toBeDefined();
    expect(panel().querySelector('[aria-pressed]')).toBeNull();
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
    expect(panelButton('Private').disabled).toBe(true);
    expect(panelButton('Team read-only').disabled).toBe(true);
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
    expect(panelButton('Private').disabled).toBe(true);
    expect(panelButton('Team read-only').disabled).toBe(true);
    expect(panel().textContent).toContain('Only the device owner can share');
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
    expect(panelButton('Team read-only').getAttribute('aria-pressed')).toBe('true');
    await act(async () => panelButton('Private').click());
    expect(trigger().textContent).toContain('Private');
    expect(panelButton('Private').getAttribute('aria-pressed')).toBe('true');
  });
});

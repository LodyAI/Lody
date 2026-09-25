// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMeta } from '@lody/shared';

import {
  SessionHeaderMenu,
  type SessionOwnerMenuState,
} from '../src/components/sessions/session-chat-interface';

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
  id: 'session-owner-test',
  machineId: 'machine-owner-test',
  userId: 'user-rem',
  createdAt: '2026-07-29T00:00:00.000Z',
  title: 'Owner test',
} as SessionMeta;

const translate = (_key: string, fallback: string) => fallback;

const members: SessionOwnerMenuState['members'] = [
  { userId: 'user-rem', name: 'Rem' },
  { userId: 'user-ada', name: 'Ada Lovelace' },
];

describe('SessionHeaderMenu owner transfer', () => {
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

  async function renderMenu(owner?: SessionOwnerMenuState): Promise<void> {
    await act(async () => {
      root?.render(
        <SessionHeaderMenu
          session={session}
          onCopyUrl={vi.fn()}
          onRename={vi.fn()}
          owner={owner}
          t={translate}
        />
      );
    });
    const trigger = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="More actions"]'
    );
    await act(async () => {
      trigger?.dispatchEvent(
        new TestPointerEvent('mousedown', { bubbles: true, button: 0, pointerType: 'mouse' })
      );
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
  }

  async function openOwnerSubmenu(): Promise<void> {
    const subTrigger = Array.from(
      document.querySelectorAll<HTMLElement>('[role="menuitem"]')
    ).find((item) => item.textContent?.includes('Change owner'));
    expect(subTrigger).toBeDefined();
    await act(async () => subTrigger?.click());
  }

  /** Rows read "<avatar initials><name>", so match by substring, not equality. */
  function ownerRow(name: string): HTMLElement {
    const row = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
      (item) => item.textContent?.includes(name)
    );
    expect(row, `owner row for ${name}`).toBeDefined();
    return row!;
  }

  it('hands the session to the selected member', async () => {
    const onChangeOwner = vi.fn();
    await renderMenu({ members, ownerUserId: 'user-rem', onChangeOwner });
    await openOwnerSubmenu();

    await act(async () => ownerRow('Ada Lovelace').click());
    expect(onChangeOwner).toHaveBeenCalledExactlyOnceWith('user-ada');
  });

  it('does not rewrite the owner when the current owner is picked again', async () => {
    const onChangeOwner = vi.fn();
    await renderMenu({ members, ownerUserId: 'user-rem', onChangeOwner });
    await openOwnerSubmenu();

    await act(async () => ownerRow('Rem').click());
    expect(onChangeOwner).not.toHaveBeenCalled();
  });

  it('blocks a second pick while a transfer is in flight', async () => {
    const onChangeOwner = vi.fn();
    await renderMenu({
      members,
      ownerUserId: 'user-rem',
      onChangeOwner,
      pendingUserId: 'user-ada',
    });
    await openOwnerSubmenu();

    const row = ownerRow('Ada Lovelace');
    expect(row.getAttribute('data-disabled')).not.toBeNull();
    await act(async () => row.click());
    expect(onChangeOwner).not.toHaveBeenCalled();
  });

  it('omits the submenu on a single-member workspace', async () => {
    await renderMenu(undefined);

    const labels = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).map(
      (item) => item.textContent?.trim()
    );
    expect(labels).not.toContain('Change owner');
  });
});

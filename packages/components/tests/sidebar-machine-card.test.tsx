// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getLodyMachinePresenceKey,
  getServerNow,
  type LodyPresenceInstanceId,
  type MachineId,
} from '@lody/shared';
import { lodyPresenceStatesAtom, lodyPresenceSyncStateAtom } from '../src/atoms/presence';
import {
  SidebarMachineHoverCard,
  SidebarMachineOfflinePill,
} from '../src/components/sidebar-machine-card';
import { SidebarSectionHeader } from '../src/components/sidebar-row-shared';
import { initI18n } from '../src/i18n';

const machineId = 'machine-sidebar-card' as MachineId;
const instanceId = 'instance-sidebar-card' as LodyPresenceInstanceId;

/** jsdom has no PointerEvent; React maps these mouse-shaped events. */
function pointer(type: string, target: EventTarget, init: MouseEventInit = {}) {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
}

describe('sidebar machine group', () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ReturnType<typeof createStore>;

  beforeEach(async () => {
    await initI18n('en');
    store = createStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  const render = async (node: React.ReactNode) => {
    await act(async () => {
      root.render(<Provider store={store}>{node}</Provider>);
    });
  };

  it('marks only a known-offline machine, never one whose status is still unknown', async () => {
    await render(<SidebarMachineOfflinePill machineId={machineId} />);
    // Presence not synced yet: the machine must not flash "Offline".
    expect(container.textContent).toBe('');

    await act(async () => store.set(lodyPresenceSyncStateAtom, 'synced'));
    expect(container.textContent).toBe('Offline');

    // A fresh heartbeat: online is the resting state and shows nothing.
    await act(async () =>
      store.set(lodyPresenceStatesAtom, {
        [getLodyMachinePresenceKey(machineId, instanceId)]: {
          kind: 'machine',
          machineId,
          instanceId,
          updatedAt: getServerNow(),
        },
      })
    );
    expect(container.textContent).toBe('');
  });

  it('tells on hover whose machine the group is, its status, OS and project count', async () => {
    vi.useFakeTimers();
    store.set(lodyPresenceSyncStateAtom, 'synced');
    await render(
      <SidebarMachineHoverCard
        machine={{
          machineId,
          name: 'Lampese.local',
          owner: { name: 'Lampese', image: null },
          isOwn: false,
          isCurrent: false,
          os: 'darwin',
          projectCount: 2,
          activity: { waiting: 0, working: 2, unread: 1 },
        }}
      >
        <SidebarSectionHeader
          label="Lampese"
          collapsed
          activity={{ waiting: 0, working: 2, unread: 1 }}
          describeActivity={false}
          onToggleCollapsed={() => undefined}
        />
      </SidebarMachineHoverCard>
    );

    const trigger = container.firstElementChild as HTMLElement;
    await act(async () => {
      pointer('pointerover', trigger, { relatedTarget: document.body });
    });
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });

    // The card portals out of the trigger's container, straight under the body.
    const card = [...document.body.children].find((node) => node !== container);
    expect(card?.textContent).toContain('Lampese.local');
    expect(card?.textContent).toContain('Offline');
    expect(card?.textContent).toContain('Lampese');
    expect(card?.textContent).toContain('macOS');
    expect(card?.textContent).toContain('2 projects');
    // The folded header draws one mark; the card, which owns its hover, counts.
    expect(card?.textContent).toContain('2 working · 1 unread');
    expect(container.querySelectorAll('[data-session-row-indicator]')).toHaveLength(1);
    expect(container.querySelector('[data-working-grid]')).not.toBeNull();
  });

  it("draws the hidden Sessions' status on a folded section header only", async () => {
    const activity = { waiting: 1, working: 3, unread: 0 };
    await render(
      <SidebarSectionHeader
        label="GitHub Worktrees"
        collapsed={false}
        activity={activity}
        onToggleCollapsed={() => undefined}
      />
    );
    // Expanded: its rows are on screen and carry their own marks.
    expect(container.querySelector('[data-sidebar-group-activity]')).toBeNull();

    await render(
      <SidebarSectionHeader
        label="GitHub Worktrees"
        collapsed
        activity={activity}
        onToggleCollapsed={() => undefined}
      />
    );
    const mark = container.querySelector('[data-sidebar-group-activity]');
    // Waiting outranks working, exactly as on a row.
    expect(mark?.querySelector('.lucide-hand')).not.toBeNull();
    expect(mark?.querySelector('[data-working-grid]')).toBeNull();
    expect(mark?.getAttribute('aria-label')).toBe('1 waiting for approval · 3 working');

    // Folded while everything is read: nothing to say.
    await render(
      <SidebarSectionHeader
        label="GitHub Worktrees"
        collapsed={false}
        onToggleCollapsed={() => undefined}
      />
    );
    await render(
      <SidebarSectionHeader
        label="GitHub Worktrees"
        collapsed
        activity={{ waiting: 0, working: 0, unread: 0 }}
        onToggleCollapsed={() => undefined}
      />
    );
    expect(container.querySelector('[data-session-row-indicator]')).toBeNull();
  });
});

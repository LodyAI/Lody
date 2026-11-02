// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { SettingsLineTabs } from '../src/components/settings/settings-line-tabs';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const localId = '11111111-1111-4111-8111-111111111111';
const remoteId = '22222222-2222-4222-8222-222222222222';
const otherId = '33333333-3333-4333-8333-333333333333';
const tabs = [localId, otherId, remoteId].map((id) => ({ id, label: 'Worker' }));
const overflow = { label: (count: number) => `${count} more` };
let root: Root;

function MachineTabs() {
  const [current, setCurrent] = useState(localId);
  return (
    <SettingsLineTabs
      tabs={tabs}
      current={current}
      onChange={setCurrent}
      label="Machine"
      overflow={overflow}
    />
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  // Deterministic layout: one machine and the overflow trigger fit in the row.
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(160);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(80);
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('selects an overflow machine by its full identity when every display name is the same', async () => {
  await act(async () => root.render(<MachineTabs />));
  expect(document.querySelectorAll('[role="tab"]')).toHaveLength(1);
  expect(
    document.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute('data-tab')
  ).toBe(localId);

  const trigger = document.querySelector<HTMLButtonElement>(
    '[role="tablist"][aria-label="Machine"] button[aria-haspopup="menu"]'
  )!;
  expect(trigger.textContent).toBe('2 more');
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50);
  });

  const menu = document.getElementById(trigger.getAttribute('aria-controls')!);
  expect(menu?.getAttribute('role')).toBe('menu');

  const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  expect(items.map((item) => item.textContent)).toEqual(['Worker', 'Worker']);
  expect(items.map((item) => item.getAttribute('data-settings-tab-overflow-id'))).toEqual([
    otherId,
    remoteId,
  ]);
  const remote = document.querySelector<HTMLElement>(
    `[data-settings-tab-overflow-id="${remoteId}"]`
  )!;
  await act(async () => remote.click());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50);
  });

  const selected = document.querySelector('[role="tab"][aria-selected="true"]');
  expect(selected?.getAttribute('data-tab')).toBe(remoteId);
  expect(document.querySelector(`[role="tab"][data-tab="${localId}"]`)).toBeNull();
});

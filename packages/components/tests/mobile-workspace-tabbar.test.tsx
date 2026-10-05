// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  MobileWorkspaceTabBar,
  type MobileWorkspaceTabBarProps,
} from '../src/components/mobile/mobile-workspace-tabbar';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const tabs = ['first', 'middle', 'last'].map((key) => ({
  key,
  label: key,
  ios: <svg />,
  material: <svg />,
}));
let root: Root;
let container: HTMLDivElement;
let scroller: HTMLDivElement;
let props: MobileWorkspaceTabBarProps;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
  container = document.createElement('div');
  scroller = document.createElement('div');
  document.body.append(container, scroller);
  root = createRoot(container);
  props = {
    tabs,
    selectedTab: 'middle',
    theme: 'ios',
    onTabSelect: (selectedTab) => render({ selectedTab }),
    scrollContainerRef: { current: scroller },
  };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  scroller.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function render(next: Partial<MobileWorkspaceTabBarProps> = {}) {
  props = { ...props, ...next };
  act(() => root.render(<MobileWorkspaceTabBar {...props} />));
}
function scroll(top: number) {
  act(() => {
    scroller.scrollTop = top;
    scroller.dispatchEvent(new Event('scroll'));
  });
}
function active() {
  return container.querySelector<HTMLElement>('[aria-selected="true"]')!;
}

it('resets baselines when switching between a list and imperative editor scroll', () => {
  render();
  scroll(180);
  expect(active().getAttribute('aria-label')).toBe('展开导航');
  act(() => active().click());
  render({ scrollSignal: { scrollTop: 900, seq: 1 } });
  expect(active().getAttribute('aria-label')).toBe('middle');
  scroll(400); // Inactive DOM source must not contaminate the editor baseline.
  render({ scrollSignal: { scrollTop: 910, seq: 2 } });
  expect(active().getAttribute('aria-label')).toBe('middle');
  render({ scrollSignal: { scrollTop: 914, seq: 3 } });
  expect(active().getAttribute('aria-label')).toBe('展开导航');
  render({ scrollSignal: { scrollTop: 900, seq: 4 } });
  expect(active().getAttribute('aria-label')).toBe('middle');
  render({ scrollSignal: null });
  expect(active().getAttribute('aria-label')).toBe('middle');
  scroll(414);
  expect(active().getAttribute('aria-label')).toBe('展开导航');
});

it('retains icon nodes through selection, reorder and removal while keeping navigation reachable', () => {
  render();
  const lastIcon = container.querySelector('[aria-label="last"] svg');
  scroll(180);
  render({ selectedTab: 'last', tabs: [tabs[2], tabs[0]] });
  expect(active().querySelector('svg')).toBe(lastIcon);
  expect(active().hasAttribute('inert')).toBe(false);
  expect(active().getAttribute('aria-label')).toBe('展开导航');
  render({ selectedTab: null });
  act(() => vi.advanceTimersByTime(1000));
  expect(container.querySelector('[aria-selected="true"]')).toBeNull();
  expect(container.querySelectorAll('[role="tab"]').length).toBe(2);
  expect(container.querySelector('[aria-label="last"] svg')).toBe(lastIcon);
  render({ tabs: [], selectedTab: 'unknown' });
  expect(container.querySelectorAll('[role="tab"]').length).toBe(0);
  render({ tabs, selectedTab: 'middle' });
  expect(active().getAttribute('aria-label')).toBe('展开导航');
});

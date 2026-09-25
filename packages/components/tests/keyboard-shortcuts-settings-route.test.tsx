// @vitest-environment jsdom

import { act, createElement } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const routerState = vi.hoisted(() => ({
  workspaceName: 'acme',
  navigateProps: null as Record<string, unknown> | null,
}));
const originalUserAgent = window.navigator.userAgent;
const originalInnerWidth = window.innerWidth;

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: { component: () => ReactNode }) => ({
    ...options,
    useParams: () => routerState,
  }),
  Navigate: (props: Record<string, unknown>) => {
    routerState.navigateProps = props;
    return createElement('p', null, `redirect:${String(props.to)}`);
  },
}));

vi.mock('../src/components/settings/keyboard-shortcuts-setting', () => ({
  KeyboardShortcutsSetting: () => createElement('p', null, 'keyboard-shortcuts-setting'),
}));

import { KeyboardShortcutsSettingsRoute } from '../src/routes/$workspaceName/_auth/settings/keyboard-shortcuts';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('KeyboardShortcutsSettingsRoute', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    Object.defineProperty(window.navigator, 'userAgent', {
      configurable: true,
      value: originalUserAgent,
    });
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 390,
    });
    routerState.navigateProps = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Object.defineProperty(window.navigator, 'userAgent', {
      configurable: true,
      value: originalUserAgent,
    });
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: originalInnerWidth,
    });
  });

  it('redirects the mobile settings route back to the category list', () => {
    act(() => root.render(createElement(KeyboardShortcutsSettingsRoute)));

    expect(container.textContent).toBe('redirect:/$workspaceName/settings');
    expect(routerState.navigateProps).toEqual({
      to: '/$workspaceName/settings',
      params: { workspaceName: 'acme' },
      search: expect.any(Function),
      replace: true,
    });
  });

  it('renders the shortcut editor on desktop widths', () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1024,
    });

    act(() => root.render(createElement(KeyboardShortcutsSettingsRoute)));

    expect(container.textContent).toBe('keyboard-shortcuts-setting');
    expect(routerState.navigateProps).toBeNull();
  });
});

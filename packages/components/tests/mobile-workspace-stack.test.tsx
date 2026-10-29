// @vitest-environment jsdom
import { act, createElement, useLayoutEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Provider, createStore } from 'jotai';
import { initI18n } from '../src/i18n';
import { getSessionCreationNavigation } from '../src/components/chat/submission/use-composer-navigation-focus';
import { MobileWorkspaceStack } from '../src/components/mobile/mobile-workspace-stack';

// Keep the actual router and Vaul stack. Session data and the persistent home
// are leaves here; their business behavior is covered by their owning suites.
vi.mock('../src/components/chat/chat-landing', () => ({
  ChatLanding: ({ mobilePresentedSessionId }: { mobilePresentedSessionId?: string }) =>
    createElement(
      'div',
      { 'data-home': true, 'data-presented-session': mobilePresentedSessionId },
      'Home'
    ),
}));
vi.mock('../src/components/sessions/session-detail', () => ({
  default: function MockSessionDetail({
    sessionId,
    onMobileBack,
    onMobilePresented,
  }: {
    sessionId: string;
    onMobileBack: () => void;
    onMobilePresented?: (id: string) => void;
  }) {
    useLayoutEffect(() => {
      onMobilePresented?.(sessionId);
    }, [sessionId, onMobilePresented]);
    return createElement(
      'main',
      { 'data-session': sessionId },
      createElement('button', { onClick: onMobileBack }, 'Back'),
      sessionId
    );
  },
}));
vi.mock('../src/components/app-theme-shell', () => ({
  AppThemeShell: ({ children }: { children: ReactNode }) => children,
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('mobile new-chat presentation', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(async () => {
    await initI18n('en');
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  const frames: FrameRequestCallback[] = [];
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    frames.length = 0;
    vi.unstubAllGlobals();
  });
  async function mount() {
    const rootRoute = createRootRoute();
    const workspace = createRoute({ getParentRoute: () => rootRoute, path: '$workspaceName' });
    const auth = createRoute({
      getParentRoute: () => workspace,
      id: '_auth',
      component: () => createElement(MobileWorkspaceStack, { workspaceName: 'workspace' }),
    });
    const chat = createRoute({ getParentRoute: () => auth, path: 'chat', component: () => null });
    const sessions = createRoute({ getParentRoute: () => auth, path: 'sessions' });
    const session = createRoute({
      getParentRoute: () => sessions,
      path: '$sessionId',
      component: () => null,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([
        workspace.addChildren([auth.addChildren([chat, sessions.addChildren([session])])]),
      ]),
      history: createMemoryHistory({ initialEntries: ['/workspace/chat'] }),
    });
    await act(async () => {
      await router.load();
      root.render(
        createElement(Provider, { store: createStore() }, createElement(RouterProvider, { router }))
      );
    });
    return router;
  }
  const drawer = () => document.querySelector('[data-vaul-drawer]');
  it('replaces the new-chat surface without a drawer entrance and consumes that request once', async () => {
    const router = await mount();
    const home = document.querySelector('[data-home]');
    await act(async () => {
      await router.navigate(getSessionCreationNavigation('workspace', 'created', true));
    });
    expect(document.querySelector('[data-session="created"]')).not.toBeNull();
    expect(drawer()?.getAttribute('data-vaul-animate')).toBe('false');
    expect(document.querySelector('[data-home]')).toBe(home);
    expect(router.history.location.state.mobileComposerSessionId).toBeUndefined();
    await act(async () => frames.splice(0).forEach((frame) => frame(0)));
    await act(async () => {
      await router.navigate({
        to: '/$workspaceName/sessions/$sessionId',
        params: { workspaceName: 'workspace', sessionId: 'created' },
        search: { tab: 'created' },
        state: (previous) => previous,
        replace: true,
      });
    });
    expect((drawer() as HTMLElement).style.animationName).toBe('none');
    expect(home?.getAttribute('data-presented-session')).toBe('created');

    await act(async () => {
      (document.querySelector('[data-session] button') as HTMLButtonElement).click();
    });
    expect(router.state.location.pathname).toBe('/workspace/chat');
    expect(drawer()?.getAttribute('data-state')).toBe('closed');
    expect(drawer()?.getAttribute('data-vaul-animate')).toBe('true');
    await act(async () => {
      await router.navigate({
        to: '/$workspaceName/sessions/$sessionId',
        params: { workspaceName: 'workspace', sessionId: 'created' },
      });
    });
    expect(drawer()?.getAttribute('data-state')).toBe('open');
    expect(drawer()?.getAttribute('data-vaul-animate')).toBe('true');
    await act(async () => {
      await router.navigate({ to: '/$workspaceName/chat', params: { workspaceName: 'workspace' } });
      await router.navigate(getSessionCreationNavigation('workspace', 'second-created', true));
    });
    expect(drawer()?.getAttribute('data-vaul-animate')).toBe('false');
    expect(document.querySelector('[data-session="second-created"]')).not.toBeNull();
    expect(document.querySelector('[data-home]')).toBe(home);
  });
  it('keeps ordinary and mismatched session entries animated', async () => {
    const router = await mount();
    await act(async () => {
      await router.navigate({
        ...getSessionCreationNavigation('workspace', 'existing', false),
        state: { mobileComposerSessionId: 'other' },
      });
    });
    expect(drawer()?.getAttribute('data-vaul-animate')).toBe('true');
    expect(document.querySelector('[data-session="existing"]')).not.toBeNull();
  });
});

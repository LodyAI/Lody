// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import type { PostHog } from 'posthog-js';
import { createPostHogPrivacy } from '../src/lib/posthog-privacy';
import { identifyPostHogUser } from '../src/lib/posthog-identity';

it('projects persisted batches again before transport in every workspace', () => {
  for (const scope of [null, 'ordinary']) {
    const sent: unknown[] = [];
    const client = { _send_request: (options: { data: unknown }) => sent.push(options.data) };
    const privacy = createPostHogPrivacy(() => scope);
    privacy.attach(client as unknown as PostHog);
    client._send_request({
      data: [
        { event: 'synthetic-private-name', properties: {} },
        { event: '$snapshot', properties: { data: 'private' } },
        { event: '$autocapture', properties: { elements: 'private' } },
        {
          event: '$pageview',
          uuid: 'private',
          timestamp: { route: 'private' },
          $set_once: { name: 'private' },
          properties: {
            $lib: 'web',
            token: 'project',
            distinct_id: 'synthetic_123',
            email: 'private',
            $current_url: 'private',
            $title: 'private',
            $set: { nested: 'private' },
            user_id: 'me@example.test',
          },
        },
        { event: '$identify', properties: { distinct_id: 'me@example.test' } },
      ],
    });
    expect(sent).toEqual([
      [
        {
          event: '$pageview',
          properties: {
            $lib: 'web',
            token: 'project',
            distinct_id: 'synthetic_123',
          },
        },
      ],
    ]);
  }
});

it('identifies only an opaque internal account id', () => {
  const calls: unknown[][] = [];
  const client = {
    identify: (...args: unknown[]) => {
      calls.push(args);
    },
  };
  identifyPostHogUser(client, 'opaque_123');
  identifyPostHogUser(client, 'test@example.test');
  expect(calls).toEqual([['opaque_123']]);
});

it('stops and resumes uploads from the settings switch and retains the choice on remount', async () => {
  const { createElement, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { PlatformContext } = await import('@lody/platform/react');
  const { TEST_CLOUD_PLATFORM } = await import('./test-platform');
  const { UsageSharingRow } = await import('../src/components/settings/usage-sharing-row');
  const { usageSharingAllowed } = await import('../src/lib/usage-sharing');
  const { initI18n } = await import('../src/i18n');
  await initI18n('en');
  const platform = {
    ...TEST_CLOUD_PLATFORM,
    cloudApi: {
      ...TEST_CLOUD_PLATFORM.cloudApi!,
      useMutation: () => async () => null,
      useOptionalAuthenticatedQuery: undefined,
    },
  } as typeof TEST_CLOUD_PLATFORM;
  const host = document.createElement('div');
  const root = createRoot(host);
  const row = createElement(
    PlatformContext.Provider,
    { value: platform },
    createElement(UsageSharingRow)
  );
  const toggle = () => host.querySelector<HTMLElement>('[role="switch"]')!;
  try {
    await act(async () => root.render(row));
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    await act(async () => toggle().click());
    expect(usageSharingAllowed()).toBe(false);
    await act(async () => root.render(null));
    await act(async () => root.render(row));
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    await act(async () => toggle().click());
    expect(usageSharingAllowed()).toBe(true);
  } finally {
    await act(async () => root.unmount());
    window.localStorage.clear();
  }
});

it.each([true, false])(
  'waits for sign-in and durable desktop onboarding before saving a choice (%s)',
  async (allow) => {
    const { createElement, act } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { PlatformContext } = await import('@lody/platform/react');
    const { TEST_CLOUD_PLATFORM } = await import('./test-platform');
    const { DesktopUsageSharingPrompt } =
      await import('../src/components/onboarding/desktop-usage-sharing-prompt');
    const { readDeviceUsageChoice, usageSharingAllowed, pendingAccountChoice } =
      await import('../src/lib/usage-sharing');
    const { initI18n } = await import('../src/i18n');
    await initI18n('en');
    vi.stubGlobal('__LODY_ELECTRON__', true);
    vi.stubGlobal('scrollTo', () => {});
    const { createStore: createPlatformStore } = await import('@lody/platform');
    const session = createPlatformStore<import('@lody/platform').PlatformSessionState>({
      status: 'unauthenticated',
    });
    const platform = {
      ...TEST_CLOUD_PLATFORM,
      identity: { ...TEST_CLOUD_PLATFORM.identity, session },
    };
    let completed = !allow;
    let nativeChoice: boolean | null = null;
    vi.stubGlobal('ipc', {
      invoke: async (channel: string, enabled: boolean) => {
        if (channel === 'app.isOnboardingCompleted') return completed;
        if (channel !== 'app.setUsageSharingEnabled') throw new Error(channel);
        nativeChoice = enabled;
      },
    });
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    const root = createRoot(mount);
    const {
      createMemoryHistory,
      createRouter,
      createRootRoute,
      createRoute,
      RouterProvider,
      Outlet,
    } = await import('@tanstack/react-router');
    const { Provider, createStore } = await import('jotai');
    const { desktopOnboardingCompletionRevisionAtom } = await import('../src/atoms/onboarding');
    const store = createStore();
    const route = createRootRoute({ component: Outlet });
    const onboarding = createRoute({ getParentRoute: () => route, path: '/onboarding' });
    const home = createRoute({
      getParentRoute: () => route,
      path: '/',
      component: DesktopUsageSharingPrompt,
    });
    const router = createRouter({
      routeTree: route.addChildren([onboarding, home]),
      history: createMemoryHistory({ initialEntries: [allow ? '/onboarding' : '/'] }),
    });
    await router.load();
    try {
      expect(readDeviceUsageChoice()).toBeNull();
      expect(usageSharingAllowed()).toBe(false);
      await act(async () =>
        root.render(
          createElement(
            PlatformContext.Provider,
            { value: platform },
            createElement(Provider, { store }, createElement(RouterProvider, { router }))
          )
        )
      );
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      await act(async () => session.set({ status: 'authenticated', user: { id: 'opaque_123' } }));
      if (allow) {
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        await act(async () => {
          await router.navigate({ to: '/' });
        });
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(usageSharingAllowed()).toBe(false);
        completed = true;
        await act(async () => store.set(desktopOnboardingCompletionRevisionAtom, 1));
      }
      const buttons = Array.from(
        document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')
      );
      expect(buttons.map((button) => button.textContent)).toEqual(['Don’t share', 'Allow sharing']);
      await act(async () => buttons[allow ? 1 : 0]!.click());
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(nativeChoice).toBe(allow);
      expect(readDeviceUsageChoice()).toBe(allow);
      expect(usageSharingAllowed()).toBe(allow);
      expect(pendingAccountChoice('opaque_123')).toBe(allow);
    } finally {
      await act(async () => root.unmount());
      mount.remove();
      window.localStorage.clear();
      vi.unstubAllGlobals();
    }
  }
);

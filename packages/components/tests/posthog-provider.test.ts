// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import type { PostHog } from 'posthog-js';
import { createPostHogPrivacy } from '../src/lib/posthog-privacy';
import { identifyPostHogUser } from '../src/lib/posthog-identity';
import { writeDeviceUsageSharing } from '../src/lib/usage-sharing';

it('blocks uploads before consent and projects persisted batches in every workspace after opt-in', () => {
  window.localStorage.clear();
  const blocked: unknown[] = [];
  const blockedClient = {
    _send_request: (options: { data: unknown }) => blocked.push(options.data),
  };
  const preConsentPrivacy = createPostHogPrivacy(() => 'ordinary');
  preConsentPrivacy.attach(blockedClient as unknown as PostHog);
  blockedClient._send_request({
    data: [{ event: 'session/message_submit_requested', properties: { distinct_id: 'u1' } }],
  });
  expect(blocked).toEqual([]);

  writeDeviceUsageSharing(true);
  try {
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
          { event: '$pageview', properties: { $current_url: 'https://app.lody.ai/private' } },
          { event: 'session/open_in_ide_clicked', properties: { $lib: 'web' } },
          {
            event: 'session/message_submit_requested',
            uuid: 'private',
            timestamp: { route: 'private' },
            offset: 0,
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
              cli_type: 'builtin',
              agent_type: 'claude',
            },
          },
          {
            event: 'session/chat',
            offset: 0,
            properties: {
              distinct_id: 'synthetic_123',
              cli_type: 'custom',
              agent_type: 'PRIVATE_CUSTOM_AGENT',
            },
          },
          {
            event: 'auth/oauth_returned',
            offset: 0,
            properties: {
              distinct_id: 'synthetic_123',
              is_new_user: true,
              outcome: 'success',
              provider: 'github',
            },
          },
          { event: '$identify', offset: 0, properties: { distinct_id: 'me@example.test' } },
        ],
      });
      expect(sent).toEqual([
        [
          {
            event: 'session/message_submit_requested',
            offset: 0,
            properties: {
              $lib: 'web',
              token: 'project',
              distinct_id: 'synthetic_123',
              platform: 'web',
              cli_type: 'builtin',
              agent_type: 'claude',
            },
          },
          {
            event: 'session/chat',
            offset: 0,
            properties: {
              distinct_id: 'synthetic_123',
              platform: 'web',
              cli_type: 'custom',
              agent_type: 'other',
            },
          },
          {
            event: 'auth/oauth_returned',
            offset: 0,
            properties: {
              distinct_id: 'synthetic_123',
              platform: 'web',
              is_new_user: true,
              outcome: 'success',
            },
          },
        ],
      ]);
    }
  } finally {
    window.localStorage.clear();
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
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(usageSharingAllowed()).toBe(false);
    await act(async () => toggle().click());
    expect(usageSharingAllowed()).toBe(true);
    window.localStorage.setItem('ph_test_posthog', 'cached-id');
    await act(async () => root.render(null));
    await act(async () => root.render(row));
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    await act(async () => toggle().click());
    expect(usageSharingAllowed()).toBe(false);
    expect(window.localStorage.getItem('ph_test_posthog')).toBeNull();
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
      cloudApi: {
        ...TEST_CLOUD_PLATFORM.cloudApi!,
        useOptionalAuthenticatedQuery: undefined,
      },
    } as typeof TEST_CLOUD_PLATFORM;
    let completed = !allow;
    let nativeChoice: boolean | null = null;
    vi.stubGlobal('ipc', {
      invoke: async (channel: string, enabled: boolean) => {
        if (channel === 'app.isOnboardingCompleted') return completed;
        if (channel === 'app.getUsageSharingEnabled') return nativeChoice;
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

it('waits for cloud save before enabling desktop usage sharing and disables the switch while account preference loads', async () => {
  const { createElement, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { PlatformContext } = await import('@lody/platform/react');
  const { createStore: createPlatformStore } = await import('@lody/platform');
  const { TEST_CLOUD_PLATFORM } = await import('./test-platform');
  const { UsageSharingRow } = await import('../src/components/settings/usage-sharing-row');
  const { usageSharingAllowed, writeDeviceUsageSharing } = await import('../src/lib/usage-sharing');
  const { initI18n } = await import('../src/i18n');
  await initI18n('en');
  vi.stubGlobal('__LODY_ELECTRON__', true);
  writeDeviceUsageSharing(false);
  const nativeCalls: boolean[] = [];
  vi.stubGlobal('ipc', {
    invoke: async (channel: string, enabled: boolean) => {
      if (channel === 'app.setUsageSharingEnabled') nativeCalls.push(enabled);
    },
  });
  let accountData: boolean | undefined = undefined;
  let shouldRejectSave = true;
  const session = createPlatformStore<import('@lody/platform').PlatformSessionState>({
    status: 'authenticated',
    user: { id: 'opaque_user' },
  });
  const platform = {
    ...TEST_CLOUD_PLATFORM,
    identity: { ...TEST_CLOUD_PLATFORM.identity, session },
    cloudApi: {
      ...TEST_CLOUD_PLATFORM.cloudApi!,
      useOptionalAuthenticatedQuery: () => ({ data: accountData }),
      useMutation: () => async () => {
        if (shouldRejectSave) throw new Error('offline');
        accountData = true;
        return null;
      },
    },
  } as unknown as typeof TEST_CLOUD_PLATFORM;
  const host = document.createElement('div');
  const root = createRoot(host);
  const renderRow = () =>
    act(async () =>
      root.render(
        createElement(PlatformContext.Provider, { value: platform }, createElement(UsageSharingRow))
      )
    );
  const toggle = () => host.querySelector<HTMLButtonElement>('[role="switch"]')!;
  try {
    await renderRow();
    expect(toggle().disabled).toBe(true);
    expect(toggle().getAttribute('aria-checked')).toBe('false');

    accountData = false;
    await renderRow();
    expect(toggle().disabled).toBe(false);
    await act(async () => toggle().click());
    expect(nativeCalls).toEqual([]);
    expect(usageSharingAllowed()).toBe(false);

    shouldRejectSave = false;
    await act(async () => toggle().click());
    expect(nativeCalls).toEqual([true]);
    expect(usageSharingAllowed()).toBe(true);
  } finally {
    await act(async () => root.unmount());
    window.localStorage.clear();
    vi.unstubAllGlobals();
  }
});

it.each([true, false])(
  'prompts on first sign-in for web and mobile clients and skips when account already opted out (%s)',
  async (allow) => {
    const { createElement, act } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { PlatformContext } = await import('@lody/platform/react');
    const { createStore: createPlatformStore } = await import('@lody/platform');
    const { TEST_CLOUD_PLATFORM } = await import('./test-platform');
    const { UsageSharingPrompt } =
      await import('../src/components/onboarding/desktop-usage-sharing-prompt');
    const {
      hasAccountUsagePromptDecision,
      pendingAccountChoice,
      readDeviceUsageChoice,
      usageSharingAllowed,
    } = await import('../src/lib/usage-sharing');
    const { initI18n } = await import('../src/i18n');
    await initI18n('en');
    vi.stubGlobal('scrollTo', () => {});
    const session = createPlatformStore<import('@lody/platform').PlatformSessionState>({
      status: 'unauthenticated',
    });
    const platform = {
      ...TEST_CLOUD_PLATFORM,
      identity: { ...TEST_CLOUD_PLATFORM.identity, session },
      cloudApi: {
        ...TEST_CLOUD_PLATFORM.cloudApi!,
        useOptionalAuthenticatedQuery: () => ({ data: true }),
      },
    } as unknown as typeof TEST_CLOUD_PLATFORM;
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    const root = createRoot(mount);
    try {
      await act(async () =>
        root.render(
          createElement(
            PlatformContext.Provider,
            { value: platform },
            createElement(UsageSharingPrompt)
          )
        )
      );
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(usageSharingAllowed()).toBe(false);
      await act(async () => session.set({ status: 'authenticated', user: { id: 'web_user_1' } }));
      const buttons = Array.from(
        document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')
      );
      expect(buttons.map((button) => button.textContent)).toEqual(['Don’t share', 'Allow sharing']);
      await act(async () => buttons[allow ? 1 : 0]!.click());
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(readDeviceUsageChoice()).toBe(allow);
      expect(hasAccountUsagePromptDecision('web_user_1')).toBe(true);
      expect(pendingAccountChoice('web_user_1')).toBe(allow);
      expect(usageSharingAllowed()).toBe(allow);
    } finally {
      await act(async () => root.unmount());
      mount.remove();
      window.localStorage.clear();
      vi.unstubAllGlobals();
    }
  }
);

it('renders the web cookie consent banner only in European consent regions and updates gtag on choice', async () => {
  const { createElement, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { WebCookieConsentBanner, readWebCookieConsent, requiresRegionalCookieConsent } =
    await import('../src/components/web-cookie-consent-banner');
  const { initI18n } = await import('../src/i18n');
  await initI18n('en');
  const gtagCalls: unknown[][] = [];
  vi.stubGlobal('gtag', (...args: unknown[]) => gtagCalls.push(args));
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  const root = createRoot(mount);
  try {
    document.cookie = 'lody-consent-region=US; path=/';
    expect(requiresRegionalCookieConsent()).toBe(false);
    await act(async () => root.render(createElement(WebCookieConsentBanner)));
    expect(mount.querySelector('aside')).toBeNull();
    await act(async () => root.unmount());

    const euRoot = createRoot(mount);
    try {
      document.cookie = 'lody-consent-region=DE; path=/';
      expect(requiresRegionalCookieConsent()).toBe(true);
      await act(async () => euRoot.render(createElement(WebCookieConsentBanner)));
      const buttons = Array.from(mount.querySelectorAll<HTMLButtonElement>('button'));
      expect(buttons.map((button) => button.textContent)).toEqual([
        'Essential only',
        'Accept analytics cookies',
      ]);
      await act(async () => buttons[1]!.click());
      expect(mount.querySelector('aside')).toBeNull();
      expect(readWebCookieConsent()).toBe('granted');
      expect(gtagCalls).toEqual([
        [
          'consent',
          'update',
          {
            ad_storage: 'denied',
            ad_user_data: 'denied',
            ad_personalization: 'denied',
            analytics_storage: 'granted',
          },
        ],
      ]);
    } finally {
      await act(async () => euRoot.unmount());
    }
  } finally {
    document.cookie = 'lody-consent-region=; Max-Age=0; path=/';
    mount.remove();
    window.localStorage.clear();
    vi.unstubAllGlobals();
  }
});

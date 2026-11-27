// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import type { PostHog } from 'posthog-js';
import { createPostHogPrivacy } from '../src/lib/posthog-privacy';
import { identifyPostHogUser } from '../src/lib/posthog-identity';
import { writeDeviceUsageSharing } from '../src/lib/usage-sharing';

it('projects persisted batches by default and blocks uploads after opt-out', () => {
  window.localStorage.clear();
  writeDeviceUsageSharing(false);
  const blocked: unknown[] = [];
  const blockedClient = {
    _send_request: (options: { data: unknown }) => blocked.push(options.data),
  };
  const optedOutPrivacy = createPostHogPrivacy(() => 'ordinary');
  optedOutPrivacy.attach(blockedClient as unknown as PostHog);
  blockedClient._send_request({
    data: [{ event: 'session/message_submit_requested', properties: { distinct_id: 'u1' } }],
  });
  expect(blocked).toEqual([]);

  window.localStorage.clear();
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
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    expect(usageSharingAllowed()).toBe(true);
    window.localStorage.setItem('ph_test_posthog', 'cached-id');
    await act(async () => toggle().click());
    expect(usageSharingAllowed()).toBe(false);
    expect(window.localStorage.getItem('ph_test_posthog')).toBeNull();
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

it('waits for cloud save before re-enabling desktop usage sharing and disables the switch while account preference loads', async () => {
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

it('allows immediate opt-out when account query fails or lags and prevents LodyPostHogProvider from bouncing back to on', async () => {
  const { createElement, act, useSyncExternalStore } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { PlatformContext } = await import('@lody/platform/react');
  const { createStore: createPlatformStore } = await import('@lody/platform');
  const { TEST_CLOUD_PLATFORM } = await import('./test-platform');
  const { UsageSharingRow } = await import('../src/components/settings/usage-sharing-row');
  const { LodyPostHogProvider } = await import('../src/providers/posthog-provider');
  const {
    pendingAccountChoice,
    readDeviceUsageChoice,
    usageSharingAllowed,
  } = await import('../src/lib/usage-sharing');
  const { initI18n } = await import('../src/i18n');
  await initI18n('en');

  const makeQueryStore = (initial: { data: boolean | undefined; error: Error | null }) => {
    let state = initial;
    const listeners = new Set<() => void>();
    return {
      get: () => state,
      set: (next: { data: boolean | undefined; error: Error | null }) => {
        state = next;
        for (const listener of listeners) listener();
      },
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  };

  vi.stubGlobal('__LODY_ELECTRON__', true);
  let diskChoice: boolean | null = null;
  const nativeWrites: boolean[] = [];
  vi.stubGlobal('ipc', {
    invoke: async (channel: string, arg?: unknown) => {
      if (channel === 'app.getUsageSharingEnabled') return diskChoice;
      if (channel === 'app.isUsageSharingDisabledByEnv') return false;
      if (channel === 'app.setUsageSharingEnabled') {
        diskChoice = arg as boolean;
        nativeWrites.push(arg as boolean);
        return;
      }
      throw new Error(`unexpected ipc: ${channel}`);
    },
  });

  const session = createPlatformStore<import('@lody/platform').PlatformSessionState>({
    status: 'authenticated',
    user: { id: 'opaque_user_optout' },
  });
  const queryStore = makeQueryStore({ data: undefined, error: new Error('backend unavailable') });
  const observedQueryArgs: unknown[] = [];
  const observedMutations: unknown[] = [];
  let rejectSave = true;

  const platform = {
    ...TEST_CLOUD_PLATFORM,
    identity: { ...TEST_CLOUD_PLATFORM.identity, session },
    cloudApi: {
      ...TEST_CLOUD_PLATFORM.cloudApi!,
      useOptionalAuthenticatedQuery: (_op: unknown, args: unknown) => {
        observedQueryArgs.push(args);
        const snap = useSyncExternalStore(queryStore.subscribe, queryStore.get, queryStore.get);
        return { ...snap, retry: () => {} };
      },
      useMutation: () => async (args: unknown) => {
        observedMutations.push(args);
        if (rejectSave) throw new Error('offline');
        return null;
      },
    },
  } as unknown as typeof TEST_CLOUD_PLATFORM;

  const host = document.createElement('div');
  const root = createRoot(host);
  const peerHost = document.createElement('div');
  const peerRoot = createRoot(peerHost);
  const toggle = () => host.querySelector<HTMLButtonElement>('[role="switch"]')!;
  try {
    // 1) Query failed: switch is ON but MUST remain clickable so opt-out fails closed immediately.
    await act(async () =>
      root.render(
        createElement(
          PlatformContext.Provider,
          { value: platform },
          createElement(LodyPostHogProvider, null, createElement(UsageSharingRow))
        )
      )
    );
    expect(observedQueryArgs[0]).toEqual({});
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    expect(toggle().disabled).toBe(false);

    await act(async () => toggle().click());
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(readDeviceUsageChoice()).toBe(false);
    expect(diskChoice).toBe(false);
    expect(usageSharingAllowed()).toBe(false);
    expect(observedMutations).toEqual([{ enabled: false }]);
    expect(pendingAccountChoice('opaque_user_optout')).toBe(false);

    // 2) Server comes back online with stale account=true and save succeeds before query flips to false.
    // Neither this window nor a second window/reload may bounce the choice back to true.
    rejectSave = false;
    observedMutations.length = 0;
    await act(async () => queryStore.set({ data: true, error: null }));
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(readDeviceUsageChoice()).toBe(false);
    expect(diskChoice).toBe(false);
    expect(observedMutations).toEqual([{ enabled: false }]);

    // Mount a second provider (simulating another Electron window or reload) while account is still true:
    await act(async () =>
      peerRoot.render(
        createElement(
          PlatformContext.Provider,
          { value: platform },
          createElement(LodyPostHogProvider, null)
        )
      )
    );
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(readDeviceUsageChoice()).toBe(false);
    expect(diskChoice).toBe(false);
    expect(usageSharingAllowed()).toBe(false);

    // Once server query confirms account=false, pending marker clears and opt-out remains stable.
    await act(async () => queryStore.set({ data: false, error: null }));
    expect(pendingAccountChoice('opaque_user_optout')).toBeNull();
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(readDeviceUsageChoice()).toBe(false);
    expect(diskChoice).toBe(false);

    // 3) Re-enable and then click OFF against a healthy backend: only 1 mutation fires, no bounce-back.
    observedMutations.length = 0;
    await act(async () => toggle().click());
    await act(async () => queryStore.set({ data: true, error: null }));
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    expect(observedMutations).toEqual([{ enabled: true }]);

    observedMutations.length = 0;
    nativeWrites.length = 0;
    await act(async () => toggle().click());
    expect(observedMutations).toEqual([{ enabled: false }]);
    expect(nativeWrites).toEqual([false]);
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(readDeviceUsageChoice()).toBe(false);
    expect(pendingAccountChoice('opaque_user_optout')).toBe(false);

    await act(async () => queryStore.set({ data: false, error: null }));
    expect(pendingAccountChoice('opaque_user_optout')).toBeNull();
    expect(toggle().getAttribute('aria-checked')).toBe('false');
  } finally {
    await act(async () => {
      root.unmount();
      peerRoot.unmount();
    });
    window.localStorage.clear();
    vi.unstubAllGlobals();
  }
});

it('preserves environment-forced telemetry opt-out in LodyPostHogProvider despite account=true', async () => {
  const { createElement, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { PlatformContext } = await import('@lody/platform/react');
  const { createStore: createPlatformStore } = await import('@lody/platform');
  const { TEST_CLOUD_PLATFORM } = await import('./test-platform');
  const { LodyPostHogProvider } = await import('../src/providers/posthog-provider');
  const { readDeviceUsageChoice, usageSharingAllowed } = await import('../src/lib/usage-sharing');

  vi.stubGlobal('__LODY_ELECTRON__', true);
  const nativeWrites: boolean[] = [];
  vi.stubGlobal('ipc', {
    invoke: async (channel: string, arg?: unknown) => {
      if (channel === 'app.getUsageSharingEnabled') return false;
      if (channel === 'app.isUsageSharingDisabledByEnv') return true;
      if (channel === 'app.setUsageSharingEnabled') {
        nativeWrites.push(arg as boolean);
        return;
      }
      throw new Error(`unexpected ipc: ${channel}`);
    },
  });
  const session = createPlatformStore<import('@lody/platform').PlatformSessionState>({
    status: 'authenticated',
    user: { id: 'opaque_user_env' },
  });
  const platform = {
    ...TEST_CLOUD_PLATFORM,
    identity: { ...TEST_CLOUD_PLATFORM.identity, session },
    cloudApi: {
      ...TEST_CLOUD_PLATFORM.cloudApi!,
      useOptionalAuthenticatedQuery: () => ({ data: true, error: null, retry: () => {} }),
      useMutation: () => async () => null,
    },
  } as unknown as typeof TEST_CLOUD_PLATFORM;

  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        createElement(
          PlatformContext.Provider,
          { value: platform },
          createElement(LodyPostHogProvider, null)
        )
      )
    );
    expect(readDeviceUsageChoice()).toBe(false);
    expect(usageSharingAllowed()).toBe(false);
    expect(nativeWrites).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    window.localStorage.clear();
    vi.unstubAllGlobals();
  }
});

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

// @vitest-environment jsdom

import { act, createElement, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { DesktopOnboardingCompletion } from '../src/components/onboarding';

const route = vi.hoisted(() => ({
  complete: null as null | ((value: DesktopOnboardingCompletion) => Promise<boolean>),
  navigate: () => Promise.resolve(),
  persist: () => Promise.resolve({ ok: true }),
  events: [] as { event: string; properties: Record<string, unknown> }[],
  now: 0,
}));
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
  useNavigate: () => route.navigate,
  Navigate: () => null,
}));
vi.mock('jotai', () => ({ useAtomValue: () => null, useSetAtom: () => () => undefined }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, text: string) => text }),
}));
vi.mock('../src/atoms/onboarding', () => ({
  desktopOnboardingDraftAtom: {},
  desktopOnboardingPhaseAtom: {},
}));
vi.mock('../src/atoms/workspace-context', () => ({ currentWorkspaceSlugAtom: {} }));
vi.mock('../src/lib/toast', () => ({ toast: { error: () => undefined } }));
vi.mock('../src/lib/electron', () => ({ isElectronRenderer: () => true }));
vi.mock('../src/lib/electron-ipc-client', () => ({
  getIpcServices: () => ({ app: { completeOnboarding: route.persist } }),
}));
vi.mock('../src/components/onboarding', () => ({
  OnboardingOverlay: ({ onCompleted }: { onCompleted: typeof route.complete }) => {
    route.complete = onCompleted;
    return null;
  },
}));
vi.mock('../src/components/onboarding/use-onboarding-theme-lifecycle', () => ({
  useOnboardingThemeLifecycle: () => () => undefined,
}));
vi.mock('../src/components/onboarding/onboarding-analytics', () => ({
  OnboardingAnalyticsProvider: ({ children }: { children: unknown }) => children,
  useOnboardingAnalytics: () => ({
    capture: (event: string, properties: Record<string, unknown>) =>
      route.events.push({ event, properties }),
    clearFlow: () => undefined,
    now: () => route.now,
    durationSince: (start: number) => route.now - start,
  }),
}));
import { Route } from '../src/routes/onboarding';
import { enterDesktopProduct } from '../src/components/onboarding/desktop-onboarding-completion';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function completionState() {
  const persistenceErrors: unknown[] = [];
  const state = { entered: false, resumable: true, failures: [] as string[] };
  return {
    state,
    persistenceErrors,
    onProductEntered: () => {
      state.entered = true;
    },
    onDurableCompletion: () => {
      state.resumable = false;
    },
    onPersistenceFailure: (error: unknown) => {
      persistenceErrors.push(error);
      state.failures.push('persistence');
    },
    onNavigationFailure: () => {
      state.failures.push('navigation');
    },
  };
}

describe('enterDesktopProduct', () => {
  it.each(['navigation', 'persistence'] as const)(
    'clears resume state only after both succeed, with %s first',
    async (first) => {
      const persistence = deferred<{ ok: true }>();
      const navigation = deferred<void>();
      const completion = completionState();
      const result = enterDesktopProduct({
        ...completion,
        persistCompletion: () => persistence.promise,
        navigate: () => navigation.promise,
      });
      if (first === 'navigation') {
        navigation.resolve();
        await expect(result).resolves.toBe(true);
        expect(completion.state).toEqual({ entered: true, resumable: true, failures: [] });
        persistence.resolve({ ok: true });
      } else {
        persistence.resolve({ ok: true });
        await persistence.promise;
        expect(completion.state).toEqual({ entered: false, resumable: true, failures: [] });
        navigation.resolve();
      }
      await result;
      await persistence.promise;
      expect(completion.state).toEqual({ entered: true, resumable: false, failures: [] });
    }
  );

  it.each(['unavailable', 'throw', 'reject', 'negative', 'late-reject'])(
    'keeps product entry successful and resume state recoverable on %s persistence',
    async (failure) => {
      const persistence = deferred<{ ok: boolean; message?: string }>();
      const completion = completionState();
      const result = enterDesktopProduct({
        ...completion,
        persistCompletion: () => {
          if (failure === 'unavailable') return undefined;
          if (failure === 'throw') throw new Error('synthetic write failure');
          return persistence.promise;
        },
        navigate: () => Promise.resolve(),
      });
      if (failure === 'late-reject') {
        await expect(result).resolves.toBe(true);
        expect(completion.state).toEqual({ entered: true, resumable: true, failures: [] });
      }
      if (failure === 'negative') persistence.resolve({ ok: false, message: 'write failed' });
      if (failure === 'reject' || failure === 'late-reject') {
        persistence.reject(new Error('synthetic write failure'));
      }
      await expect(result).resolves.toBe(true);
      expect(completion.state).toEqual({
        entered: true,
        resumable: true,
        failures: ['persistence'],
      });
      if (failure === 'negative') expect(completion.persistenceErrors).toEqual(['write failed']);
    }
  );

  it.each(['throw', 'reject'])(
    'preserves resume state after navigation %s and allows a successful retry',
    async (failure) => {
      const completion = completionState();
      const persistCompletion = () => Promise.resolve({ ok: true as const });
      const result = await enterDesktopProduct({
        ...completion,
        persistCompletion,
        navigate: () => {
          if (failure === 'throw') throw new Error('synthetic navigation failure');
          return Promise.reject(new Error('synthetic navigation failure'));
        },
      });
      expect(result).toBe(false);
      expect(completion.state).toEqual({
        entered: false,
        resumable: true,
        failures: ['navigation'],
      });
      await expect(
        enterDesktopProduct({
          ...completion,
          persistCompletion,
          navigate: () => Promise.resolve(),
        })
      ).resolves.toBe(true);
      expect(completion.state).toEqual({
        entered: true,
        resumable: false,
        failures: ['navigation'],
      });
    }
  );
});

describe('onboarding route completion events', () => {
  it('shares concurrent attempts and distinguishes entry time from durable completion time', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const persistence = deferred<{ ok: boolean }>();
    const navigation = deferred<void>();
    route.events = [];
    route.now = 10;
    route.persist = () => persistence.promise;
    route.navigate = () => navigation.promise;
    const root = createRoot(document.createElement('div'));
    try {
      await act(async () => root.render(createElement(Route.options.component as ComponentType)));
      const completion = { entryPoint: 'summary' as const };
      const first = route.complete!(completion);
      expect(route.complete!(completion)).toBe(first);
      expect(route.events.map(({ event }) => event)).toEqual(['onboarding/completion_started']);
      route.now = 30;
      navigation.resolve();
      await expect(first).resolves.toBe(true);
      expect(
        route.events
          .filter(({ event }) => event.includes('completion'))
          .map(({ event, properties }) => [event, properties.attempt, properties.duration_ms])
      ).toEqual([
        ['onboarding/completion_started', 1, undefined],
        ['onboarding/completion_succeeded', 1, 20],
      ]);
      route.now = 80;
      persistence.resolve({ ok: true });
      await persistence.promise;
      expect(route.events.at(-1)).toMatchObject({
        event: 'onboarding/flow_completed',
        properties: { attempt: 1, duration_ms: 70 },
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it('correlates a navigation retry and reports persistence failure without a durable completion', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    route.events = [];
    route.now = 0;
    route.persist = () => Promise.resolve({ ok: true });
    route.navigate = () => Promise.reject(new Error('synthetic navigation failure'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const root = createRoot(document.createElement('div'));
    try {
      await act(async () => root.render(createElement(Route.options.component as ComponentType)));
      await expect(route.complete!({})).resolves.toBe(false);
      const persistence = deferred<{ ok: boolean }>();
      route.persist = () => persistence.promise;
      route.navigate = () => Promise.resolve();
      // Re-render to refresh the injected router callback, keeping route refs.
      await act(async () => root.render(createElement(Route.options.component as ComponentType)));
      route.now = 100;
      await expect(route.complete!({})).resolves.toBe(true);
      route.now = 125;
      persistence.resolve({ ok: false });
      await persistence.promise;
      const outcomes = route.events.filter(({ event }) => event !== 'onboarding/step_exited');
      expect(outcomes.map(({ event, properties }) => [event, properties.attempt])).toEqual([
        ['onboarding/completion_started', 1],
        ['onboarding/completion_failed', 1],
        ['onboarding/completion_started', 2],
        ['onboarding/completion_succeeded', 2],
        ['onboarding/persistence_failed', 2],
      ]);
      expect(outcomes.at(-1)?.properties.duration_ms).toBe(25);
    } finally {
      act(() => root.unmount());
      error.mockRestore();
    }
  });
});

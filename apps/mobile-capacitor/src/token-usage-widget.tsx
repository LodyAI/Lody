import { App } from '@capacitor/app';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { useEffect, useMemo } from 'react';
import { atom, useAtomValue } from 'jotai';
import { jotaiStore } from '@lody/components/lib';
import type { createRouter } from '@lody/components/router';
import { activeWorkspaceRuntimeAtom, type WorkspaceRuntime } from '@lody/components/atoms/runtime';
import { useAuthenticatedConvex } from '@lody/components/hooks/use-authenticated-convex';
import { usePlatformCapability } from '@lody/platform/react';
import { useLegacyWorkspaceQuery } from '@lody/components/hooks/use-legacy-workspace-query';
import { cloudOperations } from '@lody/components/lib/cloud-api-operations';
import { formatCompactNumber } from '@lody/components/lib/format-compact-number';
import { toIntlLocaleOrEn } from '@lody/components/lib/intl-locale';
import { ErrorBoundary } from '@/components/error-boundary';
import { stripRecommended } from '@/components/shared/acp-selector-options';
import { useTranslation } from 'react-i18next';
import { homeWidgetIdentityAtom } from './home-widget';
import { createHomeWidgetSync } from './home-widget-core';
import {
  buildTokenWidgetSummary,
  resolveTokenWidgetPublication,
  type TokenWidgetSummary,
} from './token-usage-widget-core';

const bridge = registerPlugin<{
  syncTokenUsage: (options: { summary: TokenWidgetSummary | null }) => Promise<void>;
}>('LodyHomeWidget');

const activeAtom = atom(true);
const authSessionAtom = atom<string | null>(null);
const dataAtom = atom<{
  summary: TokenWidgetSummary;
  runtime: WorkspaceRuntime;
  authSessionId: string;
} | null>(null);
const summaryAtom = atom((get) => {
  return resolveTokenWidgetPublication(
    get(homeWidgetIdentityAtom),
    get(activeWorkspaceRuntimeAtom),
    get(authSessionAtom),
    get(dataAtom)
  );
});

function TokenUsageQuery() {
  const scope = useAtomValue(homeWidgetIdentityAtom);
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const active = useAtomValue(activeAtom);
  const available = usePlatformCapability('usageAnalytics');
  const { isAuthenticated, authSessionId } = useAuthenticatedConvex();
  const { i18n } = useTranslation();
  const locale = toIntlLocaleOrEn(i18n.resolvedLanguage ?? i18n.language);
  const enabled =
    available && active && isAuthenticated && authSessionId !== null && scope !== null;
  const timeline = useLegacyWorkspaceQuery(
    cloudOperations.usage.getWorkspaceUsageTimeline,
    enabled && scope !== null
      ? { workspaceId: scope.workspaceId, range: 'day', granularity: 'hour' }
      : 'skip'
  );
  const summary = useMemo(() => {
    if (scope === null || timeline === undefined) return null;
    return buildTokenWidgetSummary({
      scope,
      timeline,
      locale,
      format: formatCompactNumber,
      labelModel: stripRecommended,
    });
  }, [scope, timeline, locale]);

  useEffect(() => {
    // Loading/background suspension preserves the same scoped snapshot. An
    // auth/workspace/runtime change independently fences it in summaryAtom.
    if (!enabled || timeline === undefined) return;
    jotaiStore.set(
      dataAtom,
      summary !== null && runtime !== null && authSessionId !== null
        ? { summary, runtime, authSessionId }
        : null
    );
  }, [enabled, timeline, summary, runtime, authSessionId]);
  return null;
}

function TokenUsageHost() {
  const scope = useAtomValue(homeWidgetIdentityAtom);
  const available = usePlatformCapability('usageAnalytics');
  const { authSessionId, confirmedUnauthenticated } = useAuthenticatedConvex();
  useEffect(() => {
    jotaiStore.set(authSessionAtom, available && !confirmedUnauthenticated ? authSessionId : null);
  }, [available, authSessionId, confirmedUnauthenticated]);
  useEffect(
    () => () => {
      jotaiStore.set(authSessionAtom, null);
      jotaiStore.set(dataAtom, null);
    },
    []
  );
  return (
    <ErrorBoundary
      key={`${authSessionId ?? ''}:${scope?.userId ?? ''}:${scope?.workspaceId ?? ''}`}
      name="TokenUsageWidget"
      fallbackRender={() => null}
      propagateAuthErrors={false}
      onError={() => jotaiStore.set(dataAtom, null)}
    >
      <TokenUsageQuery />
    </ErrorBoundary>
  );
}

/** Mobile composition installs this leaf inside the existing authenticated route. */
export function initTokenUsageWidget(router: ReturnType<typeof createRouter>): () => Promise<void> {
  if (Capacitor.getPlatform() !== 'ios') return async () => {};
  const route = router.routesById['/$workspaceName/_auth'];
  const OriginalRoute = route.options.component;
  if (OriginalRoute === undefined) throw new Error('Missing authenticated mobile route component');
  const NativeWidgetRoute = () => {
    return (
      <>
        <OriginalRoute />
        <TokenUsageHost />
      </>
    );
  };
  route.update({ component: NativeWidgetRoute });
  const sync = createHomeWidgetSync<TokenWidgetSummary>({
    read: () => jotaiStore.get(summaryAtom),
    sync: (summary) => bridge.syncTokenUsage({ summary }),
    schedule: (callback) => {
      const timer = window.setTimeout(callback, 250);
      return () => window.clearTimeout(timer);
    },
    scheduleRetry: (callback, delayMs) => {
      const timer = window.setTimeout(callback, delayMs);
      return () => window.clearTimeout(timer);
    },
    now: Date.now,
    onError: (error) => console.error('Failed to update Token usage widget', error),
  });
  // Scope/auth loss clears immediately; valid query updates are coalesced.
  const unsubscribe = jotaiStore.sub(summaryAtom, () =>
    sync.refresh({
      immediate: jotaiStore.get(summaryAtom) === null,
    })
  );
  sync.refresh({ immediate: true, force: true });
  const listener = App.addListener('appStateChange', ({ isActive }) => {
    jotaiStore.set(activeAtom, isActive);
    if (isActive) sync.refresh({ immediate: true, force: true });
  });
  void listener.catch((error: unknown) =>
    console.error('Failed to watch Token widget app state', error)
  );
  return async () => {
    unsubscribe();
    if (route.options.component === NativeWidgetRoute) route.update({ component: OriginalRoute });
    if (jotaiStore.get(summaryAtom) === null) {
      sync.refresh({ immediate: true, force: true });
      await sync.whenSettled();
    }
    await Promise.all([
      sync.stop(),
      listener
        .then((handle) => handle.remove())
        .catch((error: unknown) => {
          console.error('Failed to remove Token widget app state listener', error);
        }),
    ]);
  };
}

import { App } from '@capacitor/app';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { atom } from 'jotai';
import { jotaiStore } from '@lody/components/lib';
import { activeWorkspaceRuntimeAtom, type WorkspaceRuntime } from '@lody/components/atoms/runtime';
import { getAllAgentConfigAtom } from '@lody/components/atoms/agents';
import { getMachineMetaMapAtom } from '@lody/components/atoms/machines';
import { onlineMachineIdsAtom } from '@lody/components/atoms/presence';
import {
  canShowSubscriptionRateLimits,
  formatRateLimitWindowShortLabel,
  getAgentRateLimitEntries,
  getAgentRateLimitWindows,
} from '@lody/components/lib/session-usage';
import { languageAtom } from '@lody/components/atoms/settings';
import { homeWidgetIdentityAtom, homeWidgetScopeAtom } from './home-widget';
import {
  createHomeWidgetSync,
  homeWidgetBridgeOptions,
  type HomeWidgetBridgeOptions,
  type HomeWidgetPending,
} from './home-widget-core';
import {
  buildProviderQuotaWidgetSummary,
  selectQuotaProviders,
  type ProviderQuotaSource,
  type ProviderQuotaWidgetSummary,
} from './provider-quota-widget-core';

const bridge = registerPlugin<{
  syncProviderQuota: (
    options: HomeWidgetBridgeOptions<ProviderQuotaWidgetSummary>
  ) => Promise<void>;
}>('LodyHomeWidget');

const inputAtom = atom((get) => {
  const scope = get(homeWidgetScopeAtom);
  const runtime = get(activeWorkspaceRuntimeAtom);
  if (!scope || !runtime) return null;
  const machines = get(getMachineMetaMapAtom);
  const online = get(onlineMachineIdsAtom);
  const providers = get(getAllAgentConfigAtom).flatMap((config) => {
    const machine = machines.get(config.machineId);
    if (!machine || machine.ownerUserId !== scope.userId) return [];
    const capability = machine.acpCapabilities?.[config.id]?.rateLimits;
    if (!canShowSubscriptionRateLimits({ ...config, config, capability })) return [];
    return [
      { config, machine, online: online.has(machine.id), canQuery: capability?.query === true },
    ];
  });
  return { scope, runtime, providers, locale: get(languageAtom) };
});

function readSummary(): ProviderQuotaWidgetSummary | HomeWidgetPending | null {
  const identity = jotaiStore.get(homeWidgetIdentityAtom);
  if (!identity) return null;
  const input = jotaiStore.get(inputAtom);
  if (!input) return { pendingScope: identity };
  const sources: ProviderQuotaSource[] = [];
  for (const { config, machine, online } of input.providers) {
    for (const entry of getAgentRateLimitEntries(machine.raceLimits, config.agentType, config.id)) {
      const windows = getAgentRateLimitWindows(entry.limits).map((window) => ({
        label: [formatRateLimitWindowShortLabel(window.windowDurationSeconds), window.label]
          .filter(Boolean)
          .join(' · '),
        remainingPercent: window.remainingPercent,
        resetsAt: window.resetsAtEpochSeconds,
      }));
      sources.push({
        id: `${machine.id}/${entry.key}`,
        agentType: config.agentType,
        name: entry.limits.limitName ? `${config.name} · ${entry.limits.limitName}` : config.name,
        machineName: machine.name,
        machineOwnerId: machine.ownerUserId,
        online,
        windows,
      });
    }
  }
  return buildProviderQuotaWidgetSummary({
    scope: input.scope,
    sources,
    locale: input.locale,
  });
}

export function initProviderQuotaWidget(): () => Promise<void> {
  if (Capacitor.getPlatform() !== 'ios') return async () => {};
  let active = true;
  let stopped = false;
  let owner: WorkspaceRuntime | null = null;
  let requested = new Set<string>();
  const sync = createHomeWidgetSync({
    read: readSummary,
    sync: (summary) => bridge.syncProviderQuota(homeWidgetBridgeOptions(summary)),
    schedule: (callback) => {
      const timer = window.setTimeout(callback, 250);
      return () => window.clearTimeout(timer);
    },
    scheduleRetry: (callback, delayMs) => {
      const timer = window.setTimeout(callback, delayMs);
      return () => window.clearTimeout(timer);
    },
    now: Date.now,
    onError: (error) => console.error('Failed to update subscription quota widget', error),
  });
  const refreshProviders = () => {
    const input = jotaiStore.get(inputAtom);
    if (!active || stopped || !input) return;
    if (owner !== input.runtime) {
      owner = input.runtime;
      requested = new Set();
    }
    const targets = selectQuotaProviders(
      input.providers
        .filter((provider) => provider.online && provider.canQuery)
        .map((provider) => ({
          ...provider,
          id: `${provider.machine.id}/${encodeURIComponent(provider.config.id)}`,
          agentType: provider.config.agentType,
        }))
    );
    const targetKeys = new Set(targets.map((provider) => provider.id));
    for (const key of requested) {
      if (!targetKeys.has(key)) requested.delete(key);
    }
    for (const { config, machine, id: key } of targets) {
      if (requested.has(key)) continue;
      requested.add(key);
      // The existing runtime/daemon owns coalescing, read-only ACP work and cleanup.
      void input.runtime.requestProviderRateLimitsRefresh?.(machine.id, config.id).catch(() => {
        // Keep the last snapshot on unavailable/older runtimes. Foreground retries.
      });
    }
  };
  const unsubscribe = jotaiStore.sub(inputAtom, () => {
    sync.refresh({ immediate: jotaiStore.get(homeWidgetScopeAtom) === null });
    refreshProviders();
  });
  const unsubscribeIdentity = jotaiStore.sub(homeWidgetIdentityAtom, () =>
    sync.refresh({ immediate: true })
  );
  sync.refresh({ immediate: true, force: true });
  refreshProviders();
  const listener = App.addListener('appStateChange', ({ isActive }) => {
    active = isActive;
    if (isActive && !stopped) {
      requested.clear();
      refreshProviders();
      sync.refresh({ immediate: true, force: true });
    }
  });
  void listener.catch((error: unknown) =>
    console.error('Failed to watch quota widget app state', error)
  );
  return async () => {
    stopped = true;
    unsubscribe();
    unsubscribeIdentity();
    if (jotaiStore.get(homeWidgetScopeAtom) === null) {
      sync.refresh({ immediate: true, force: true });
      await sync.whenSettled();
    }
    await Promise.all([sync.stop(), listener.then((handle) => handle.remove())]);
  };
}

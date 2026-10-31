import { createHash } from 'node:crypto';
import type { RateLimitsSnapshot } from 'acp-extension-core';
import type { SessionId, SessionTurnInputConfig, SessionContextWindowUsage } from '@lody/shared';

export type ProviderBinding = { bindingId: string; fingerprint: string };

/** Machine-local launch identity. Never publish credential-derived hashes to synced metadata. */
export function providerBindingFingerprint(config: {
  id?: string;
  cliType: string;
  agentType: string;
  env?: Record<string, string>;
  customAcp?: unknown;
  runtimeOverrides?: unknown;
  codexAuth?: unknown;
  magpieGatewayUrl?: string;
}): string {
  const ordered = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(ordered)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, child]) => [key, ordered(child)])
          )
        : value;
  return createHash('sha256')
    .update(
      JSON.stringify(
        ordered({
          id: config.id,
          cliType: config.cliType,
          agentType: config.agentType,
          env: config.env ?? {},
          customAcp: config.customAcp,
          runtimeOverrides: config.runtimeOverrides,
          codexAuth: config.codexAuth,
          magpieGatewayUrl: config.magpieGatewayUrl,
        })
      )
    )
    .digest('hex');
}

export type SessionAutomationObservation = {
  sessionId: SessionId;
  turnId: string;
  assistantTurnId: string;
  userId: string;
  nativeSessionId?: string;
  binding?: ProviderBinding;
  modelId?: string;
  outcome: 'completed' | 'failed' | 'cancelled' | 'unknown';
  capacityFailure?: 'rate_limited' | 'quota_exhausted' | 'provider_overloaded';
  inputConfig: SessionTurnInputConfig;
  released: boolean;
  finalized: boolean;
  capacity?: RateLimitsSnapshot;
  context?: SessionContextWindowUsage;
  observedAt: number;
};
export type AutomationObservationSink = {
  stage(observation: SessionAutomationObservation): void;
  turn(observation: SessionAutomationObservation): Promise<void>;
  capacity(
    binding: ProviderBinding,
    snapshot: RateLimitsSnapshot,
    source: 'query' | 'push'
  ): Promise<void>;
};

import { BUILTIN_AGENTS } from '../ai';

const eventNames = new Set([
  'acp/agent_config_used',
  'app/active',
  'app/boot_failed',
  'app/launch',
  'auth/email_sign_up_succeeded',
  'auth/oauth_returned',
  'mobile/boot_failed',
  'session/chat',
  'session/message_submit_requested',
  'session/start_success',
]);

const agentProviderEvents = new Set([
  'acp/agent_config_used',
  'session/chat',
  'session/message_submit_requested',
  'session/start_success',
]);

const platforms = new Set(['web', 'electron', 'mobile', 'cli'] as const);
const nativePlatforms = new Set(['ios', 'android'] as const);
const cliTypes = new Set(['builtin', 'registry', 'custom'] as const);
const builtinAgentTypes = new Set<string>(BUILTIN_AGENTS.map((agent) => agent.agentType));

export type TelemetryPlatform = 'web' | 'electron' | 'mobile' | 'cli';
export type TelemetryNativePlatform = 'ios' | 'android';
export type TelemetryCliType = 'builtin' | 'registry' | 'custom';

export function isPostHogProductEvent(name: string): boolean {
  return eventNames.has(name);
}

export function isAgentProviderTelemetryEvent(name: string): boolean {
  return agentProviderEvents.has(name);
}

export function isTelemetryPlatform(value: unknown): value is TelemetryPlatform {
  return typeof value === 'string' && platforms.has(value as TelemetryPlatform);
}

export function isTelemetryNativePlatform(value: unknown): value is TelemetryNativePlatform {
  return typeof value === 'string' && nativePlatforms.has(value as TelemetryNativePlatform);
}

export function isTelemetryCliType(value: unknown): value is TelemetryCliType {
  return typeof value === 'string' && cliTypes.has(value as TelemetryCliType);
}

export function normalizeTelemetryAgentType(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return undefined;
  return builtinAgentTypes.has(trimmed) ? trimmed : 'other';
}

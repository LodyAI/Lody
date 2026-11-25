import type { ReactNode } from 'react';
import { KeyRound, Sparkles } from 'lucide-react';
import type { SorbetConnectionSource } from '@lody/shared/electron-ipc';
import { AnthropicIcon } from '@/components/icons/anthropic-icon';
import { DeepSeekIcon } from '@/components/icons/deepseek-icon';
import { GlmIcon } from '@/components/icons/glm-icon';
import { MinimaxIcon } from '@/components/icons/minimax-icon';
import { OpenAIIcon } from '@/components/icons/openai-icon';

export type DetectedApiKeyProvider = {
  providerId: string;
  providerName: string;
  confidence: 'exact' | 'shared-prefix';
};

export const API_KEY_PROVIDER_OPTIONS: ReadonlyArray<{
  providerId: string;
  providerName: string;
}> = [
  { providerId: 'anthropic', providerName: 'Anthropic' },
  { providerId: 'openai', providerName: 'OpenAI' },
  { providerId: 'google', providerName: 'Google Gemini' },
  { providerId: 'deepseek', providerName: 'DeepSeek' },
  { providerId: 'openrouter', providerName: 'OpenRouter' },
  { providerId: 'xai', providerName: 'xAI' },
  { providerId: 'groq', providerName: 'Groq' },
  { providerId: 'mistral', providerName: 'Mistral' },
];

/**
 * Prefix-based API key brand detection (§5.3):
 * recognizes unambiguous prefixes immediately, and treats generic `sk-` keys
 * as OpenAI with a switchable provider pill in case the key belongs to DeepSeek.
 */
export function detectProviderFromApiKeyPrefix(rawKey: string): DetectedApiKeyProvider | null {
  const key = rawKey.trim();
  if (!key) return null;
  if (key.startsWith('sk-ant-')) {
    return { providerId: 'anthropic', providerName: 'Claude', confidence: 'exact' };
  }
  if (key.startsWith('sk-or-')) {
    return { providerId: 'openrouter', providerName: 'OpenRouter', confidence: 'exact' };
  }
  if (key.startsWith('sk-proj-') || key.startsWith('sk-svcacct-')) {
    return { providerId: 'openai', providerName: 'OpenAI', confidence: 'exact' };
  }
  if (key.startsWith('AIza')) {
    return { providerId: 'google', providerName: 'Gemini', confidence: 'exact' };
  }
  if (key.startsWith('xai-')) {
    return { providerId: 'xai', providerName: 'xAI', confidence: 'exact' };
  }
  if (key.startsWith('gsk_')) {
    return { providerId: 'groq', providerName: 'Groq', confidence: 'exact' };
  }
  if (key.startsWith('sk-')) {
    return { providerId: 'openai', providerName: 'OpenAI', confidence: 'shared-prefix' };
  }
  return null;
}

export function maskApiKeyDisplay(rawKey: string): string {
  const trimmed = rawKey.trim();
  if (trimmed.length <= 6) return trimmed;
  const last4 = trimmed.slice(-4);
  return `••••••••••••${last4}`;
}

/**
 * Lightweight provider mark without pulling large icon packs into `/onboarding`.
 */
export function ProviderBrandIcon({
  providerId,
  size = 16,
  neutral = false,
}: {
  providerId?: string | null;
  size?: number;
  neutral?: boolean;
}): ReactNode {
  if (neutral || !providerId) {
    return <KeyRound size={size} strokeWidth={1.8} aria-hidden="true" />;
  }
  const normalized = providerId.toLowerCase();
  const boxStyle = {
    width: size,
    height: size,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  } as const;

  if (normalized === 'anthropic' || normalized.includes('claude')) {
    return (
      <span style={boxStyle} aria-hidden="true">
        <AnthropicIcon />
      </span>
    );
  }
  if (normalized === 'openai' || normalized === 'openai-codex' || normalized.includes('chatgpt')) {
    return (
      <span style={boxStyle} aria-hidden="true">
        <OpenAIIcon />
      </span>
    );
  }
  if (normalized === 'deepseek') {
    return (
      <span style={boxStyle} aria-hidden="true">
        <DeepSeekIcon />
      </span>
    );
  }
  if (normalized === 'glm' || normalized === 'zai') {
    return (
      <span style={boxStyle} aria-hidden="true">
        <GlmIcon />
      </span>
    );
  }
  if (normalized === 'minimax') {
    return (
      <span style={boxStyle} aria-hidden="true">
        <MinimaxIcon />
      </span>
    );
  }
  if (normalized.includes('copilot')) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
        style={{ flexShrink: 0 }}
      >
        <rect x="2" y="4" width="12" height="8" rx="4" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="6" cy="8" r="1.2" fill="currentColor" />
        <circle cx="10" cy="8" r="1.2" fill="currentColor" />
      </svg>
    );
  }
  if (normalized.includes('google') || normalized.includes('gemini')) {
    return <Sparkles size={size} strokeWidth={1.8} aria-hidden="true" />;
  }

  const initial = providerId.trim().charAt(0).toUpperCase() || 'M';
  return (
    <span
      aria-hidden="true"
      style={{
        ...boxStyle,
        borderRadius: 4,
        fontSize: Math.max(10, size - 4),
        fontWeight: 650,
        lineHeight: 1,
      }}
    >
      {initial}
    </span>
  );
}

export function resolveSubscriptionCardMeta(method: {
  providerId: string;
  providerName: string;
  name: string;
}): { title: string; subtitle: string } {
  const id = method.providerId.toLowerCase();
  if (id === 'anthropic') {
    return { title: 'Claude', subtitle: 'Pro · Max' };
  }
  if (id === 'openai-codex' || id === 'openai') {
    return { title: 'ChatGPT', subtitle: 'Plus · Pro' };
  }
  if (id === 'github-copilot' || id === 'copilot') {
    return { title: 'Copilot', subtitle: 'GitHub' };
  }
  if (id.includes('google') || id.includes('gemini')) {
    return { title: 'Gemini', subtitle: 'Google' };
  }
  return {
    title: method.providerName || method.name,
    subtitle: method.name !== method.providerName ? method.name : '',
  };
}

export function formatConnectionSourceBadge(
  source: SorbetConnectionSource,
  translate: (key: string, options?: Record<string, unknown>) => string
): string {
  if (source.kind === 'oauth') {
    return translate('onboarding.model.source.subscription', { defaultValue: 'Subscription' });
  }
  if (source.kind === 'imported') {
    if (source.from === 'claude-code') {
      return translate('onboarding.model.source.importedClaudeCode', {
        defaultValue: 'Imported from Claude Code',
      });
    }
    if (source.from === 'codex') {
      return translate('onboarding.model.source.importedCodex', {
        defaultValue: 'Imported from Codex',
      });
    }
    return translate('onboarding.model.source.importedEnv', {
      defaultValue: 'Imported from env',
    });
  }
  if (source.last4) {
    return translate('onboarding.model.source.apiKeyMasked', {
      last4: source.last4,
      defaultValue: `API Key ····${source.last4}`,
    });
  }
  return translate('onboarding.model.source.apiKey', { defaultValue: 'API Key' });
}

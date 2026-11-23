import type { ReactNode } from 'react';
import { SiGithubcopilot, SiGooglegemini } from 'react-icons/si';
import { AnthropicIcon } from '@/components/icons/anthropic-icon';
import { DeepSeekIcon } from '@/components/icons/deepseek-icon';
import { GlmIcon } from '@/components/icons/glm-icon';
import { MinimaxIcon } from '@/components/icons/minimax-icon';
import { OpenAIIcon } from '@/components/icons/openai-icon';

const icons: Record<string, (props: { className?: string }) => ReactNode> = {
  anthropic: AnthropicIcon,
  openai: OpenAIIcon,
  google: SiGooglegemini,
  'google-gemini-cli': SiGooglegemini,
  'github-copilot': SiGithubcopilot,
  deepseek: DeepSeekIcon,
  minimax: MinimaxIcon,
  zai: GlmIcon,
};

/** Provider ids are identities; compatible endpoint protocols are not brands. */
export function SorbetProviderIcon({
  providerId,
  className,
  fallback,
}: {
  providerId: string;
  className?: string;
  fallback: ReactNode;
}) {
  const key = providerId.toLowerCase();
  const Icon = Object.hasOwn(icons, key) ? icons[key] : undefined;
  return Icon ? <Icon className={className} /> : fallback;
}

/** Authentication method ids are advertised as `sorbet:<providerId>:<method>`. */
export function sorbetAuthProviderId(methodId: string): string | null {
  const match = /^sorbet:(.+):(oauth|api_key)$/.exec(methodId);
  return match?.[1] ?? null;
}

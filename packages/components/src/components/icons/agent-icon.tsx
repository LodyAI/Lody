import type { ReactNode } from 'react';
import { Bot, SquareTerminal } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { clsx } from 'clsx';
import {
  REGISTRY_ACP_AGENTS,
  getBuiltinAgentByAgentType,
  resolveAgentBrandId,
  type AgentBrandId,
  type AgentConfigCliType,
  type BuiltinAgentType,
} from '@lody/shared';
import { SiXiaomi } from 'react-icons/si';
import type { IconType } from 'react-icons';
import { AnthropicIcon } from './anthropic-icon';
import { DeepSeekIcon } from './deepseek-icon';
import { GlmIcon } from './glm-icon';
import { MinimaxIcon } from './minimax-icon';
import { OpenAIIcon } from './openai-icon';
import { InlineSvg } from './inline-svg';
import { REGISTRY_AGENT_ICON_SVGS } from './registry-agent-icons';
import { ICON_GLYPH_BOX_CLASS, iconSurface } from './surface';
import bubSvg from '@/assets/bub.svg?raw';
import dimcodeSvg from '@/assets/dimcode.svg?raw';
import lodySvg from '@/assets/lody.svg?raw';

const lodyAgentSvg = lodySvg.replace('fill="#E2E8F0"', 'fill="currentColor"');

const registryNameMap = new Map(REGISTRY_ACP_AGENTS.map((a) => [a.id, a.name] as const));

export function getAgentDisplayName(
  cliType: AgentConfigCliType | null | undefined,
  agentType: string | null | undefined
): string | null {
  if (!cliType || !agentType) return null;
  if (cliType === 'builtin') {
    return getBuiltinAgentByAgentType(agentType)?.displayName ?? agentType;
  }
  // Custom agentTypes are per-config uuid slugs; the config's `name` is the
  // real display name, which callers with access to the config should prefer.
  if (cliType === 'custom') return 'Custom Agent';
  return registryNameMap.get(agentType) ?? agentType;
}

type BrandIconComponent = (props: { className?: string }) => ReactNode;

function ReactBrandIcon({ icon: Icon, className }: { icon: IconType; className?: string }) {
  return (
    <span className={className} aria-hidden="true">
      <Icon size="1em" />
    </span>
  );
}

/**
 * Single source of truth mapping a provider brand to its icon. The preset
 * definitions in `agent-config-dialog.tsx` consume this too, so the dialog and
 * every avatar render the same glyph.
 */
export const AGENT_BRAND_ICONS: Record<AgentBrandId, BrandIconComponent> = {
  deepseek: DeepSeekIcon,
  mimo: ({ className }) => <ReactBrandIcon icon={SiXiaomi} className={className} />,
  minimax: MinimaxIcon,
  glm: GlmIcon,
};

export type AgentIconSlug =
  | { kind: 'builtin'; agentType: BuiltinAgentType }
  | { kind: 'preset'; preset: 'deepseek-claude' | 'deepseek-reasonix' }
  | { kind: 'registry'; agentType: string };

export function AgentIcon({
  cliType,
  agentType,
  brandId,
  env,
  className,
  fallback,
}: {
  cliType: AgentConfigCliType;
  agentType: string;
  /** Override the generic icon when the provider cannot be identified. */
  fallback?: ReactNode;
  /** Provider brand persisted on the agent config (preset-created agents). */
  brandId?: AgentBrandId;
  /** Agent/session env; used to infer the brand for configs created before `brandId` existed. */
  env?: Record<string, string>;
  className?: string;
}) {
  const cls = className ?? ICON_GLYPH_BOX_CLASS;
  const fill = stylex.props(iconSurface.glyphFill);
  /** The wrapper the raw registry markup is painted into. */
  const inlineGlyphClass = clsx(fill.className, cls);
  if (cliType === 'custom') {
    return <SquareTerminal className={cls} />;
  }
  if (cliType === 'builtin') {
    // Preset-created agents run as builtin/claude but should show their provider
    // brand. Resolve brand first (env is the retroactive fallback); registry
    // agents are left untouched and keep their own icon.
    const brand = resolveAgentBrandId({ brandId, env });
    if (brand) {
      const BrandIcon = AGENT_BRAND_ICONS[brand];
      return <BrandIcon className={cls} />;
    }
    if (agentType === 'claude') return <AnthropicIcon className={cls} />;
    if (agentType === 'codex') return <OpenAIIcon className={cls} />;
    if (agentType === 'deepseek') return <DeepSeekIcon className={cls} />;
    if (agentType === 'bub' || agentType === 'dimcode' || agentType === 'sorbet') {
      return (
        <InlineSvg
          fillParent
          raw={
            agentType === 'sorbet' ? lodyAgentSvg : agentType === 'dimcode' ? dimcodeSvg : bubSvg
          }
          className={inlineGlyphClass}
        />
      );
    }
    if (agentType === 'grok') {
      const grokRaw = REGISTRY_AGENT_ICON_SVGS['grok-build'];
      if (grokRaw) {
        return <InlineSvg fillParent raw={grokRaw} className={inlineGlyphClass} />;
      }
    }
  }
  if (cliType === 'registry' && agentType === 'claude-p') {
    return <AnthropicIcon className={cls} />;
  }
  const raw =
    REGISTRY_AGENT_ICON_SVGS[cliType === 'builtin' && agentType === 'pi' ? 'pi-acp' : agentType];
  if (raw) {
    return <InlineSvg fillParent raw={raw} className={inlineGlyphClass} />;
  }
  return fallback !== undefined ? fallback : <Bot className={cls} />;
}

export { DeepSeekIcon };

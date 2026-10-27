import type { ReactNode } from 'react';
import { Sparkles } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { clsx } from 'clsx';
import { AnthropicIcon } from './anthropic-icon';
import { DeepSeekIcon } from './deepseek-icon';
import { GlmIcon } from './glm-icon';
import { MinimaxIcon } from './minimax-icon';
import { OpenAIIcon } from './openai-icon';
import { InlineSvg } from './inline-svg';
import { REGISTRY_AGENT_ICON_SVGS } from './registry-agent-icons';
import { iconSurface } from './surface';

/**
 * The registry SVG is raw markup, so its own `<svg>` element cannot be given a
 * class. StyleX has no descendant selector either, so the two rules that make
 * the inner glyph fill its wrapper stay Tailwind classes on the wrapper.
 */
const SVG_FILL_CLASS = '[&_svg]:h-full [&_svg]:w-full';

/**
 * Model ids are free-form provider strings (`claude-sonnet-5`, `gpt-5-codex`,
 * `gemini-2.5-pro`, …), so the brand is matched by prefix. Order matters: the
 * first match wins, and the list is checked as written.
 *
 * Every glyph here inherits `currentColor`, so callers get a monochrome mark by
 * setting a text colour.
 */
const BRAND_MATCHERS: Array<{
  test: RegExp;
  render: (className: string | undefined) => ReactNode;
}> = [
  { test: /^(claude|anthropic)/, render: (c) => <AnthropicIcon className={c} /> },
  { test: /^(gpt|codex|o[1-9]|chatgpt|openai)/, render: (c) => <OpenAIIcon className={c} /> },
  { test: /^deepseek/, render: (c) => <DeepSeekIcon className={c} /> },
  { test: /^(glm|zhipu)/, render: (c) => <GlmIcon className={c} /> },
  { test: /^(minimax|abab)/, render: (c) => <MinimaxIcon className={c} /> },
  { test: /^gemini/, render: (c) => <RegistrySvg name="gemini" className={c} /> },
  { test: /^(kimi|moonshot)/, render: (c) => <RegistrySvg name="kimi" className={c} /> },
  { test: /^(qwen|qwq)/, render: (c) => <RegistrySvg name="qwen-code" className={c} /> },
  { test: /^grok/, render: (c) => <RegistrySvg name="grok-build" className={c} /> },
  {
    test: /^(mistral|codestral|devstral)/,
    render: (c) => <RegistrySvg name="mistral-vibe" className={c} />,
  },
];

function RegistrySvg({ name, className }: { name: string; className: string | undefined }) {
  const raw = REGISTRY_AGENT_ICON_SVGS[name];
  if (!raw) return <Sparkles className={className} />;
  return (
    <InlineSvg
      raw={raw}
      className={clsx(stylex.props(iconSurface.glyphFill).className, className, SVG_FILL_CLASS)}
    />
  );
}

/** Monochrome provider mark for a usage `modelId`. */
export function ModelBrandIcon({ modelId, className }: { modelId: string; className?: string }) {
  const cls = className ?? stylex.props(iconSurface.glyphBoxSmall).className;
  // Ids arrive with vendor routing prefixes such as `anthropic/claude-...` or
  // `openrouter:google/gemini-...`; the last segment carries the model name.
  const normalized = modelId.toLowerCase().split(/[:/]/).pop() ?? '';
  for (const matcher of BRAND_MATCHERS) {
    if (matcher.test.test(normalized)) return matcher.render(cls);
  }
  return <Sparkles className={cls} />;
}

import * as stylex from '@stylexjs/stylex';
import type { LucideIcon } from 'lucide-react';
import {
  ArrowUp,
  Boxes,
  Bot,
  Braces,
  Check,
  ChevronDown,
  Clock,
  Code,
  Coins,
  Cpu,
  Gauge,
  Gem,
  LoaderCircle,
  Pause,
  Play,
  Sparkles,
  SquareTerminal,
  Target,
  Terminal,
  X,
  Zap,
} from 'lucide-react';
import { ReplicaRunConfigTrigger } from '../landing-replica/composer-controls';
import type { ReplicaLocale } from '../landing-replica/types';
const previewStyles = stylex.create({
  section: {
    'margin-block': 'calc(var(--spacing) * 6)',
  },
  text: {
    overflow: 'hidden',
    'border-radius': 'var(--radius-xl)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'hsl(var(--border))',
    'background-color': 'hsl(var(--background))',
    color: 'hsl(var(--foreground))',
    'box-shadow': '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, var(--shadow-sm)',
  },
  section2: {
    padding: 'calc(var(--spacing) * 4)',
    '@media (width >= 40rem)': {
      padding: 'calc(var(--spacing) * 6)',
    },
  },
  frame: {
    'margin-inline': 'auto',
    width: '100%',
    'max-width': '320px',
  },
  text2: {
    'margin-bottom': 'calc(var(--spacing) * 2)',
    'font-size': 'var(--text-base)',
    'line-height': 'var(--text-base--line-height)',
    'font-weight': 'var(--font-weight-semibold)',
    'letter-spacing': 'var(--tracking-tight)',
    '@media (width >= 40rem)': {
      'font-size': 'var(--text-lg)',
      'line-height': 'var(--text-lg--line-height)',
    },
  },
  section3: {
    position: 'relative',
  },
  row: {
    display: 'flex',
    height: 'calc(var(--spacing) * 11)',
    'align-items': 'center',
    'justify-content': 'space-between',
    'border-radius': 'var(--radius-lg)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'hsl(var(--input-border))',
    'background-color': 'hsl(var(--card))',
    'padding-inline': 'calc(var(--spacing) * 3)',
    'font-size': 'var(--text-base)',
    'line-height': 'var(--text-base--line-height)',
    'font-weight': 'var(--font-weight-medium)',
    'box-shadow': '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, var(--shadow-xs)',
  },
  text3: {
    height: 'calc(var(--spacing) * 4)',
    width: 'calc(var(--spacing) * 4)',
    color: 'hsl(var(--muted-foreground))',
  },
  section4: {
    'margin-top': 'calc(var(--spacing) * 1.5)',
    overflow: 'hidden',
    'border-radius': 'var(--radius-lg)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'hsl(var(--border))',
    'background-color': 'hsl(var(--popover))',
    'box-shadow': '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, var(--shadow-lg)',
  },
  row2: {
    display: 'flex',
    'align-items': 'center',
    'justify-content': 'space-between',
    'background-color': 'hsl(var(--selection))',
    'padding-inline': 'calc(var(--spacing) * 3)',
    'padding-block': 'calc(var(--spacing) * 2.5)',
    'font-size': 'var(--text-base)',
    'line-height': 'var(--text-base--line-height)',
  },
  frame2: {
    height: 'calc(var(--spacing) * 4)',
    width: 'calc(var(--spacing) * 4)',
  },
  text4: {
    'padding-inline': 'calc(var(--spacing) * 3)',
    'padding-block': 'calc(var(--spacing) * 2.5)',
    'font-size': 'var(--text-base)',
    'line-height': 'var(--text-base--line-height)',
  },
  text5: {
    'margin-top': 'calc(var(--spacing) * 2)',
    'text-align': 'center',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    color: 'hsl(var(--muted-foreground))',
  },
  frame3: {
    'margin-inline': 'auto',
    width: '100%',
    'max-width': 'var(--container-3xl)',
  },
  row3: {
    'margin-bottom': 'calc(var(--spacing) * 3)',
    display: 'flex',
    'align-items': 'flex-end',
    'justify-content': 'space-between',
    gap: 'calc(var(--spacing) * 3)',
  },
  text6: {
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
    'font-weight': 'var(--font-weight-semibold)',
  },
  text7: {
    'margin-top': 'calc(var(--spacing) * 0.5)',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    color: 'hsl(var(--muted-foreground))',
  },
  text8: {
    'border-radius': 'calc(infinity * 1px)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'hsl(var(--border))',
    'padding-inline': 'calc(var(--spacing) * 2)',
    'padding-block': 'var(--spacing)',
    'font-size': '10px',
    'font-weight': 'var(--font-weight-medium)',
    'letter-spacing': 'var(--tracking-wide)',
    color: 'hsl(var(--muted-foreground))',
    'text-transform': 'uppercase',
  },
  grid: {
    display: 'grid',
    gap: 'calc(var(--spacing) * 2)',
    '@media (width >= 40rem)': {
      'grid-template-columns': 'repeat(2, minmax(0, 1fr))',
    },
  },
  row4: {
    display: 'flex',
    'min-width': '0px',
    'align-items': 'center',
    'justify-content': 'space-between',
    gap: 'calc(var(--spacing) * 3)',
    'border-radius': 'var(--radius-lg)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'color-mix(in oklab, hsl(var(--border)) 70%, transparent)',
    'background-color': 'hsl(var(--card))',
    'padding-inline': 'calc(var(--spacing) * 3)',
    'padding-block': 'calc(var(--spacing) * 2.5)',
  },
  row5: {
    display: 'flex',
    'min-width': '0px',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 2.5)',
  },
  row6: {
    display: 'flex',
    height: 'calc(var(--spacing) * 7)',
    width: 'calc(var(--spacing) * 7)',
    'flex-shrink': '0',
    'align-items': 'center',
    'justify-content': 'center',
    'border-radius': 'var(--radius-md)',
    'background-color': 'hsl(var(--muted))',
    color: 'hsl(var(--muted-foreground))',
  },
  text9: {
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
    'font-weight': 'var(--font-weight-medium)',
  },
  text10: {
    'flex-shrink': '0',
    'border-radius': 'var(--radius-md)',
    'background-color': 'hsl(var(--muted))',
    'padding-inline': 'calc(var(--spacing) * 2)',
    'padding-block': 'var(--spacing)',
    'font-size': '10px',
    'font-weight': 'var(--font-weight-semibold)',
    'letter-spacing': 'var(--tracking-wide)',
    color: 'hsl(var(--muted-foreground))',
    'text-transform': 'uppercase',
  },
  frame4: {
    'margin-inline': 'auto',
    width: '100%',
    'max-width': 'var(--container-2xl)',
  },
  row7: {
    display: 'flex',
    'flex-wrap': 'wrap',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 2)',
    'border-radius': 'var(--radius-lg)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'hsl(var(--border))',
    'background-color': 'hsl(var(--card))',
    padding: 'calc(var(--spacing) * 2)',
    'box-shadow': '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, var(--shadow-sm)',
  },
  frame5: {
    height: 'calc(var(--spacing) * 4)',
    width: '1px',
    'background-color': 'hsl(var(--border))',
  },
  row8: {
    display: 'inline-flex',
    height: 'calc(var(--spacing) * 7)',
    'flex-shrink': '0',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 1.5)',
    'border-radius': '4px',
    'background-color': 'color-mix(in oklab, hsl(var(--status-success)) 10%, transparent)',
    'padding-inline': 'calc(var(--spacing) * 2)',
    'font-size': '0.9em',
    'line-height': 'var(--leading-tight)',
    color: 'hsl(var(--status-success))',
    '-webkit-user-select': 'none',
    'user-select': 'none',
  },
  frame6: {
    height: 'calc(var(--spacing) * 4)',
    width: 'calc(var(--spacing) * 4)',
    'flex-shrink': '0',
  },
  text11: {
    'border-radius': '0.25rem',
    'background-color': 'color-mix(in oklab, hsl(var(--status-success)) 15%, transparent)',
    'padding-inline': 'calc(var(--spacing) * 1.5)',
    'padding-block': 'calc(var(--spacing) * 0.5)',
    'font-size': '10px',
    'font-weight': 'var(--font-weight-semibold)',
    'text-transform': 'uppercase',
  },
  row9: {
    'margin-top': 'calc(var(--spacing) * 2)',
    display: 'flex',
    'align-items': 'flex-start',
    gap: 'calc(var(--spacing) * 2)',
    'border-radius': 'var(--radius-lg)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'color-mix(in oklab, hsl(var(--status-success)) 20%, transparent)',
    'background-color': 'color-mix(in oklab, hsl(var(--status-success)) 6%, transparent)',
    'padding-inline': 'calc(var(--spacing) * 3)',
    'padding-block': 'calc(var(--spacing) * 2)',
  },
  text12: {
    'margin-top': 'calc(var(--spacing) * 0.5)',
    height: 'calc(var(--spacing) * 3.5)',
    width: 'calc(var(--spacing) * 3.5)',
    'flex-shrink': '0',
    color: 'hsl(var(--status-success))',
  },
  text13: {
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--leading-relaxed)',
    color: 'hsl(var(--muted-foreground))',
  },
  text14: {
    'font-weight': 'var(--font-weight-medium)',
    color: 'hsl(var(--foreground))',
  },
  stack: {
    display: 'flex',
    'min-width': '0px',
    'flex-direction': 'column',
    'border-radius': 'var(--radius-xl)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'hsl(var(--border))',
    'background-color': 'hsl(var(--card))',
    padding: 'calc(var(--spacing) * 4)',
    'box-shadow': '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, var(--shadow-sm)',
  },
  text15: {
    width: 'fit-content',
    'border-radius': 'calc(infinity * 1px)',
    'background-color': 'hsl(var(--muted))',
    'padding-inline': 'calc(var(--spacing) * 2)',
    'padding-block': 'calc(var(--spacing) * 0.5)',
    'font-size': '10px',
    'font-weight': 'var(--font-weight-semibold)',
    'letter-spacing': 'var(--tracking-wide)',
    color: 'hsl(var(--muted-foreground))',
    'text-transform': 'uppercase',
  },
  text16: {
    'margin-top': 'calc(var(--spacing) * 2)',
    'font-size': 'var(--text-base)',
    'line-height': 'var(--leading-snug)',
    'font-weight': 'var(--font-weight-semibold)',
  },
  stack2: {
    'margin-top': 'calc(var(--spacing) * 3)',
    display: 'flex',
    'flex-direction': 'column',
    gap: 'calc(var(--spacing) * 1.5)',
  },
  row10: {
    display: 'flex',
    'align-items': 'flex-start',
    gap: 'calc(var(--spacing) * 3)',
    'border-radius': 'var(--radius-lg)',
    'border-style': 'solid',
    'border-width': '1px',
    'padding-inline': 'calc(var(--spacing) * 3)',
    'padding-block': 'calc(var(--spacing) * 2)',
  },
  section5: {
    'border-color': 'color-mix(in oklab, hsl(var(--primary)) 35%, transparent)',
    'background-color': 'color-mix(in oklab, hsl(var(--primary)) 4%, transparent)',
  },
  section6: {
    'border-color': 'color-mix(in oklab, hsl(var(--border)) 70%, transparent)',
  },
  row11: {
    'margin-top': 'calc(var(--spacing) * 0.5)',
    display: 'flex',
    width: 'calc(var(--spacing) * 4)',
    height: 'calc(var(--spacing) * 4)',
    'flex-shrink': '0',
    'align-items': 'center',
    'justify-content': 'center',
    'border-style': 'solid',
    'border-width': '1px',
  },
  section7: {
    'border-radius': '3px',
  },
  section8: {
    'border-radius': 'calc(infinity * 1px)',
  },
  text17: {
    'border-color': 'hsl(var(--primary))',
    'background-color': 'hsl(var(--primary))',
    color: 'hsl(var(--primary-foreground))',
  },
  section9: {
    'border-color': 'hsl(var(--input-border))',
    'background-color': 'hsl(var(--background))',
  },
  frame7: {
    height: 'calc(var(--spacing) * 3)',
    width: 'calc(var(--spacing) * 3)',
  },
  frame8: {
    width: 'calc(var(--spacing) * 1.5)',
    height: 'calc(var(--spacing) * 1.5)',
    'border-radius': 'calc(infinity * 1px)',
    'background-color': 'hsl(var(--primary-foreground))',
  },
  section10: {
    'min-width': '0px',
  },
  text18: {
    display: 'block',
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
    'font-weight': 'var(--font-weight-medium)',
  },
  text19: {
    'margin-top': 'calc(var(--spacing) * 0.5)',
    display: 'block',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--leading-relaxed)',
    color: 'hsl(var(--muted-foreground))',
  },
  row12: {
    'margin-top': 'calc(var(--spacing) * 3)',
    display: 'flex',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 2)',
    'border-radius': 'var(--radius-lg)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'hsl(var(--input-border))',
    'background-color': 'hsl(var(--background))',
    'padding-inline': 'calc(var(--spacing) * 3)',
    'padding-block': 'calc(var(--spacing) * 2)',
  },
  text20: {
    'min-width': '0px',
    flex: '1',
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    color: 'hsl(var(--input-placeholder))',
  },
  row13: {
    display: 'flex',
    width: 'calc(var(--spacing) * 6)',
    height: 'calc(var(--spacing) * 6)',
    'flex-shrink': '0',
    'align-items': 'center',
    'justify-content': 'center',
    'border-radius': 'var(--radius-md)',
    'background-color': 'hsl(var(--muted))',
    color: 'hsl(var(--muted-foreground))',
  },
  frame9: {
    height: 'calc(var(--spacing) * 3.5)',
    width: 'calc(var(--spacing) * 3.5)',
  },
  section11: {
    'pointer-events': 'none',
    'background-color': 'color-mix(in oklab, hsl(var(--muted)) 20%, transparent)',
    padding: 'calc(var(--spacing) * 4)',
    '@media (width >= 40rem)': {
      padding: 'calc(var(--spacing) * 6)',
    },
  },
  grid2: {
    'margin-inline': 'auto',
    display: 'grid',
    width: '100%',
    'max-width': 'var(--container-3xl)',
    gap: 'calc(var(--spacing) * 4)',
    '@media (width >= 48rem)': {
      'grid-template-columns': 'repeat(2, minmax(0, 1fr))',
    },
  },
  row14: {
    display: 'inline-flex',
    height: 'calc(var(--spacing) * 7)',
    'flex-shrink': '0',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 1.5)',
    'border-radius': 'var(--radius-md)',
    'border-style': 'solid',
    'border-width': '1px',
    'padding-inline': 'calc(var(--spacing) * 2)',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    'font-weight': 'var(--font-weight-medium)',
  },
  text21: {
    'border-color': 'hsl(var(--border))',
    'background-color': 'hsl(var(--card))',
    color: 'hsl(var(--foreground))',
  },
  text22: {
    'border-color': 'color-mix(in oklab, hsl(var(--status-success)) 35%, transparent)',
    'background-color': 'color-mix(in oklab, hsl(var(--status-success)) 10%, transparent)',
    color: 'hsl(var(--status-success))',
  },
  text23: {
    'border-color': 'color-mix(in oklab, hsl(var(--destructive)) 30%, transparent)',
    'background-color': 'hsl(var(--background))',
    color: 'hsl(var(--destructive))',
  },
  section12: {
    opacity: '45%',
  },
  section13: {
    'background-color': 'color-mix(in oklab, hsl(var(--status-info)) 10%, transparent)',
  },
  row15: {
    display: 'flex',
    'flex-wrap': 'wrap',
    'align-items': 'center',
    'justify-content': 'space-between',
    gap: 'calc(var(--spacing) * 2)',
    'border-bottom-style': 'solid',
    'border-bottom-width': '1px',
    'border-color': 'color-mix(in oklab, hsl(var(--status-info)) 30%, transparent)',
    'padding-inline': 'calc(var(--spacing) * 3)',
    'padding-block': 'calc(var(--spacing) * 2)',
  },
  row16: {
    display: 'flex',
    'min-width': '0px',
    'flex-wrap': 'wrap',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 2)',
  },
  text24: {
    height: 'calc(var(--spacing) * 4)',
    width: 'calc(var(--spacing) * 4)',
    'flex-shrink': '0',
    color: 'hsl(var(--status-info))',
  },
  text25: {
    'font-size': '11px',
    'font-weight': 'var(--font-weight-semibold)',
    'letter-spacing': 'var(--tracking-wide)',
    color: 'hsl(var(--status-info))',
    'text-transform': 'uppercase',
  },
  row17: {
    display: 'inline-flex',
    'align-items': 'center',
    gap: 'var(--spacing)',
    'border-radius': 'calc(infinity * 1px)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'color-mix(in oklab, hsl(var(--status-info)) 30%, transparent)',
    'background-color': 'color-mix(in oklab, hsl(var(--background)) 70%, transparent)',
    'padding-inline': 'calc(var(--spacing) * 2)',
    'padding-block': 'calc(var(--spacing) * 0.5)',
    'font-size': '10px',
    'font-weight': 'var(--font-weight-semibold)',
    'letter-spacing': 'var(--tracking-wide)',
    color: 'hsl(var(--status-info))',
    'text-transform': 'uppercase',
  },
  row18: {
    display: 'flex',
    'flex-shrink': '0',
    'flex-wrap': 'wrap',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 1.5)',
  },
  section14: {
    'padding-inline': 'calc(var(--spacing) * 3)',
    'padding-top': 'calc(var(--spacing) * 2)',
    'padding-bottom': 'calc(var(--spacing) * 3)',
  },
  text26: {
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--leading-snug)',
    'font-weight': 'var(--font-weight-medium)',
  },
  row19: {
    'margin-top': 'calc(var(--spacing) * 2)',
    display: 'flex',
    'flex-wrap': 'wrap',
    'align-items': 'center',
    'column-gap': 'calc(var(--spacing) * 3)',
    'row-gap': 'var(--spacing)',
    'font-size': '11px',
    color: 'hsl(var(--muted-foreground))',
  },
  row20: {
    display: 'inline-flex',
    'align-items': 'center',
    gap: 'var(--spacing)',
  },
  frame10: {
    'margin-top': 'calc(var(--spacing) * 2)',
    height: 'calc(var(--spacing) * 1.5)',
    overflow: 'hidden',
    'border-radius': 'calc(infinity * 1px)',
    'background-color': 'color-mix(in oklab, hsl(var(--background)) 80%, transparent)',
  },
  frame11: {
    height: '100%',
    width: 'calc(1 / 4 * 100%)',
    'border-radius': 'calc(infinity * 1px)',
    'background-color': 'hsl(var(--status-info))',
  },
});

/* Display-only previews for the docs' runtime reference and Claude/Codex
   capability pages. They replace static screenshots with synthetic data and
   intentionally reuse only site-docs relative primitives plus lucide-react.
   Source markup/copy was copied from the app files named on each component;
   none of these previews import the app, @lody/*, Convex, jotai, or i18next. */

type PreviewProps = { locale?: ReplicaLocale };

// ─── Agent config type selector ─────────────────────────────────────────────
// Source: packages/components/src/components/settings/agent-config-dialog.tsx
// Story: packages/components/src/stories/AgentConfigDialog.stories.tsx

type AgentConfigCopy = {
  title: string;
  claude: string;
  codex: string;
  caption: string;
};

const AGENT_CONFIG_COPY: Record<ReplicaLocale, AgentConfigCopy> = {
  en: {
    title: 'Configuration Type',
    claude: 'Claude',
    codex: 'Codex',
    caption:
      'Mock selector. Choose Claude for Claude-compatible endpoints or Codex for OpenAI runtimes.',
  },
  zh: {
    title: '配置类型',
    claude: 'Claude',
    codex: 'Codex',
    caption: '模拟选择器。Claude 用于 Claude 兼容端点，Codex 用于 OpenAI 运行时。',
  },
};

/** Static configuration-type select with its option list held open. */
export function AgentConfigPreview({ locale = 'en' }: PreviewProps) {
  const copy = AGENT_CONFIG_COPY[locale];
  return (
    <div {...stylex.props(previewStyles.section)}>
      <div
        aria-hidden="true"
        className={[
          'lody-app-preview',
          stylex.props(previewStyles.text, previewStyles.section2).className,
        ].join(' ')}
      >
        <div {...stylex.props(previewStyles.frame)}>
          <div {...stylex.props(previewStyles.text2)}>{copy.title}</div>
          <div {...stylex.props(previewStyles.section3)}>
            <div {...stylex.props(previewStyles.row)}>
              <span>{copy.claude}</span>
              <ChevronDown {...stylex.props(previewStyles.text3)} />
            </div>
            <div {...stylex.props(previewStyles.section4)}>
              <div {...stylex.props(previewStyles.row2)}>
                <span>{copy.claude}</span>
                <Check {...stylex.props(previewStyles.frame2)} strokeWidth={2.5} />
              </div>
              <div {...stylex.props(previewStyles.text4)}>{copy.codex}</div>
            </div>
          </div>
        </div>
      </div>
      <p {...stylex.props(previewStyles.text5)}>{copy.caption}</p>
    </div>
  );
}

// ─── Registry runtime picker ────────────────────────────────────────────────
// Source: packages/components/src/components/settings/provider-row.tsx,
// provider-setup-row.tsx, agent-config-dialog.tsx
// Stories: packages/components/src/stories/ProviderRow.stories.tsx,
// ProviderSetupRow.stories.tsx

type RuntimeOption = {
  name: string;
  icon: LucideIcon;
};

const REGISTRY_RUNTIMES: RuntimeOption[] = [
  { name: 'Auggie CLI', icon: SquareTerminal },
  { name: 'Autohand Code', icon: Bot },
  { name: 'Cline', icon: Code },
  { name: 'Codebuddy Code', icon: Braces },
  { name: 'Factory Droid', icon: Cpu },
  { name: 'Gemini CLI', icon: Sparkles },
  { name: 'Kimi CLI', icon: Gem },
  { name: 'OpenCode', icon: Terminal },
  { name: 'Qwen Code', icon: Boxes },
  { name: 'pi ACP', icon: Bot },
];

type CliRuntimeCopy = {
  title: string;
  subtitle: string;
  experimental: string;
  caption: string;
};

const CLI_RUNTIME_COPY: Record<ReplicaLocale, CliRuntimeCopy> = {
  en: {
    title: 'ACP Provider',
    subtitle: 'Runtimes from the ACP Registry',
    experimental: 'Experimental',
    caption:
      'Mock registry picker. Install the selected runtime on the target machine before running it.',
  },
  zh: {
    title: 'ACP 运行时',
    subtitle: '来自 ACP Registry 的运行时',
    experimental: '实验性',
    caption: '模拟注册表选择器。使用前需在目标机器上安装所选运行时。',
  },
};

/** Static list of registry runtimes, copied from the provider picker rows. */
export function CliRuntimePreview({ locale = 'en' }: PreviewProps) {
  const copy = CLI_RUNTIME_COPY[locale];
  return (
    <div {...stylex.props(previewStyles.section)}>
      <div
        aria-hidden="true"
        className={[
          'lody-app-preview',
          stylex.props(previewStyles.text, previewStyles.section2).className,
        ].join(' ')}
      >
        <div {...stylex.props(previewStyles.frame3)}>
          <div {...stylex.props(previewStyles.row3)}>
            <div>
              <div {...stylex.props(previewStyles.text6)}>{copy.title}</div>
              <div {...stylex.props(previewStyles.text7)}>{copy.subtitle}</div>
            </div>
            <span {...stylex.props(previewStyles.text8)}>ACP</span>
          </div>
          <div {...stylex.props(previewStyles.grid)}>
            {REGISTRY_RUNTIMES.map(({ name, icon: Icon }) => (
              <div key={name} {...stylex.props(previewStyles.row4)}>
                <span {...stylex.props(previewStyles.row5)}>
                  <span {...stylex.props(previewStyles.row6)}>
                    <Icon {...stylex.props(previewStyles.frame2)} aria-hidden="true" />
                  </span>
                  <span {...stylex.props(previewStyles.text9)}>{name}</span>
                </span>
                <span {...stylex.props(previewStyles.text10)}>{copy.experimental}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <p {...stylex.props(previewStyles.text5)}>{copy.caption}</p>
    </div>
  );
}

// ─── Fast / Think run-config controls ───────────────────────────────────────
// Source: packages/components/src/components/sessions/desktop-run-config-menu.tsx,
// packages/components/src/components/mobile/mobile-fast-plan-toggles.tsx

type FastModeCopy = {
  model: string;
  thinking: string;
  fast: string;
  on: string;
  tradeoff: string;
  caption: string;
};

const FAST_MODE_COPY: Record<ReplicaLocale, FastModeCopy> = {
  en: {
    model: 'gpt-5.5',
    thinking: 'Xhigh',
    fast: 'Fast',
    on: 'On',
    tradeoff: 'Tradeoff:',
    caption:
      'Fast mode uses the quickest inference tier for future turns — roughly 2.5× faster at a higher cost per token.',
  },
  zh: {
    model: 'gpt-5.5',
    thinking: 'Xhigh',
    fast: 'Fast',
    on: '开',
    tradeoff: '权衡：',
    caption: 'Fast 模式会为后续轮次使用最快的推理档位——速度约提升 2.5 倍，但每个 token 成本更高。',
  },
};

/** Static composer footer face: model + thinking trigger and a lit Fast control. */
export function FastModePreview({ locale = 'en' }: PreviewProps) {
  const copy = FAST_MODE_COPY[locale];
  return (
    <div {...stylex.props(previewStyles.section)}>
      <div
        aria-hidden="true"
        className={[
          'lody-app-preview',
          stylex.props(previewStyles.text, previewStyles.section2).className,
        ].join(' ')}
      >
        <div {...stylex.props(previewStyles.frame4)}>
          <div {...stylex.props(previewStyles.row7)}>
            <ReplicaRunConfigTrigger
              agent="codex"
              modelLabel={copy.model}
              thinkLabel={copy.thinking}
            />
            <span aria-hidden="true" {...stylex.props(previewStyles.frame5)} />
            <span {...stylex.props(previewStyles.row8)}>
              <Zap {...stylex.props(previewStyles.frame6)} strokeWidth={1.8} aria-hidden="true" />
              <span>{copy.fast}</span>
              <span {...stylex.props(previewStyles.text11)}>{copy.on}</span>
            </span>
          </div>
          <div {...stylex.props(previewStyles.row9)}>
            <Zap {...stylex.props(previewStyles.text12)} aria-hidden="true" />
            <p {...stylex.props(previewStyles.text13)}>
              <span {...stylex.props(previewStyles.text14)}>{copy.tradeoff}</span> {copy.caption}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── AskUserQuestion card ───────────────────────────────────────────────────
// Source: packages/components/src/components/sessions/ask-user-question-card.tsx
// Story: packages/components/src/stories/AskUserQuestionCard.stories.tsx

type AskOptionCopy = {
  label: string;
  description: string;
  selected?: boolean;
};

type AskQuestionCopy = {
  badge: string;
  question: string;
  options: AskOptionCopy[];
  customPlaceholder?: string;
};

type AskQuestionPreviewCopy = {
  single: AskQuestionCopy;
  multi: AskQuestionCopy;
  caption: string;
};

const ASK_QUESTION_COPY: Record<ReplicaLocale, AskQuestionPreviewCopy> = {
  en: {
    single: {
      badge: 'Single select',
      question: 'What did you eat?',
      options: [
        {
          label: 'Breakfast',
          description: 'Morning meal — e.g., eggs, toast, oatmeal, congee',
          selected: true,
        },
        {
          label: 'Lunch',
          description: 'Midday meal — e.g., sandwich, salad, rice bowl',
        },
        {
          label: 'Dinner',
          description: 'Evening meal — e.g., pasta, stir-fry, hotpot',
        },
        {
          label: 'Snack',
          description: 'Light bite between meals — e.g., fruit, nuts, chips',
        },
      ],
      customPlaceholder: 'Type a custom answer...',
    },
    multi: {
      badge: 'Multi-select',
      question: 'Which constraints matter?',
      options: [
        {
          label: 'Offline',
          description: 'Must keep working without a network',
          selected: true,
        },
        {
          label: 'Compatibility',
          description: 'Preserve the existing public API',
        },
        {
          label: 'Speed',
          description: 'Prefer the lowest-latency path',
          selected: true,
        },
      ],
    },
    caption:
      'Mock AskUserQuestion card. The runtime can request single-select, multi-select, or custom answers while a task is running.',
  },
  zh: {
    single: {
      badge: '单选',
      question: '你吃了什么？',
      options: [
        {
          label: '早餐',
          description: '早上吃的——例如鸡蛋、吐司、燕麦、粥',
          selected: true,
        },
        {
          label: '午餐',
          description: '中午吃的——例如三明治、沙拉、盖饭',
        },
        {
          label: '晚餐',
          description: '晚上吃的——例如意面、炒菜、火锅',
        },
        {
          label: '零食',
          description: '两餐之间的小食——例如水果、坚果、薯片',
        },
      ],
      customPlaceholder: '输入自定义回答……',
    },
    multi: {
      badge: '多选',
      question: '哪些约束条件重要？',
      options: [
        {
          label: '离线',
          description: '无网络时也必须可用',
          selected: true,
        },
        {
          label: '兼容性',
          description: '保留现有公开 API',
        },
        {
          label: '速度',
          description: '优先使用延迟最低的路径',
          selected: true,
        },
      ],
    },
    caption: '模拟 AskUserQuestion 卡片。运行时可在任务执行中请求单选、多选或自定义回答。',
  },
};

function AskQuestionCard({
  question,
  multiSelect,
}: {
  question: AskQuestionCopy;
  multiSelect: boolean;
}) {
  return (
    <div {...stylex.props(previewStyles.stack)}>
      <span {...stylex.props(previewStyles.text15)}>{question.badge}</span>
      <h3 {...stylex.props(previewStyles.text16)}>{question.question}</h3>
      <div {...stylex.props(previewStyles.stack2)}>
        {question.options.map((option) => (
          <div
            key={option.label}
            {...stylex.props(
              previewStyles.row10,
              option.selected ? previewStyles.section5 : previewStyles.section6
            )}
          >
            <span
              {...stylex.props(
                previewStyles.row11,
                multiSelect ? previewStyles.section7 : previewStyles.section8,
                option.selected ? previewStyles.text17 : previewStyles.section9
              )}
            >
              {option.selected ? (
                multiSelect ? (
                  <Check {...stylex.props(previewStyles.frame7)} strokeWidth={3} />
                ) : (
                  <span {...stylex.props(previewStyles.frame8)} />
                )
              ) : null}
            </span>
            <span {...stylex.props(previewStyles.section10)}>
              <span {...stylex.props(previewStyles.text18)}>{option.label}</span>
              <span {...stylex.props(previewStyles.text19)}>{option.description}</span>
            </span>
          </div>
        ))}
      </div>
      {question.customPlaceholder ? (
        <div {...stylex.props(previewStyles.row12)}>
          <span {...stylex.props(previewStyles.text20)}>{question.customPlaceholder}</span>
          <span {...stylex.props(previewStyles.row13)}>
            <ArrowUp {...stylex.props(previewStyles.frame9)} aria-hidden="true" />
          </span>
        </div>
      ) : null}
    </div>
  );
}

/** Static AskUserQuestion examples for single-select, multi-select and custom answers. */
export function AskQuestionPreview({ locale = 'en' }: PreviewProps) {
  const copy = ASK_QUESTION_COPY[locale];
  return (
    <div {...stylex.props(previewStyles.section)}>
      <div
        aria-hidden="true"
        className={[
          'lody-app-preview',
          stylex.props(previewStyles.text, previewStyles.section11).className,
        ].join(' ')}
      >
        <div {...stylex.props(previewStyles.grid2)}>
          <AskQuestionCard question={copy.single} multiSelect={false} />
          <AskQuestionCard question={copy.multi} multiSelect />
        </div>
      </div>
      <p {...stylex.props(previewStyles.text5)}>{copy.caption}</p>
    </div>
  );
}

// ─── Goal status banner ─────────────────────────────────────────────────────
// Source: packages/components/src/components/sessions/session-goal-banner.tsx,
// packages/components/src/components/sessions/session-goal-control.ts
// Story: packages/components/src/stories/SessionGoalBanner.stories.tsx

type GoalCopy = {
  label: string;
  status: string;
  objective: string;
  pause: string;
  resume: string;
  clear: string;
  elapsed: string;
  tokens: string;
  progress: string;
  elapsedValue: string;
  tokensValue: string;
  progressValue: string;
  caption: string;
};

const GOAL_COPY: Record<ReplicaLocale, GoalCopy> = {
  en: {
    label: 'Goal',
    status: 'Pursuing goal',
    objective: 'explain how remote preview works?',
    pause: 'Pause',
    resume: 'Resume',
    clear: 'Clear',
    elapsed: 'Elapsed',
    tokens: 'tokens',
    progress: 'Progress',
    elapsedValue: '16s',
    tokensValue: '12.4K / 50K',
    progressValue: '25%',
    caption:
      'Mock goal banner. Active goals show Pause; paused goals show Resume. Elapsed and token data are synthetic.',
  },
  zh: {
    label: '目标',
    status: '执行目标中',
    objective: '解释远程预览如何工作？',
    pause: '暂停',
    resume: '继续',
    clear: '清除',
    elapsed: '已用',
    tokens: 'tokens',
    progress: '进度',
    elapsedValue: '16s',
    tokensValue: '12.4K / 50K',
    progressValue: '25%',
    caption: '模拟目标横幅。目标进行中显示暂停，暂停后显示继续。时间与 token 数据为模拟值。',
  },
};

function GoalAction({
  icon: Icon,
  label,
  tone = 'neutral',
  muted = false,
}: {
  icon: LucideIcon;
  label: string;
  tone?: 'neutral' | 'success' | 'danger';
  muted?: boolean;
}) {
  return (
    <span
      {...stylex.props(
        previewStyles.row14,
        tone === 'neutral' && previewStyles.text21,
        tone === 'success' && previewStyles.text22,
        tone === 'danger' && previewStyles.text23,
        muted && previewStyles.section12
      )}
    >
      <Icon {...stylex.props(previewStyles.frame9)} aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

/** Static Codex-style goal banner with objective, usage and state controls. */
export function GoalPreview({ locale = 'en' }: PreviewProps) {
  const copy = GOAL_COPY[locale];
  return (
    <div {...stylex.props(previewStyles.section)}>
      <div
        aria-hidden="true"
        className={[
          'lody-app-preview',
          stylex.props(previewStyles.text, previewStyles.section13).className,
        ].join(' ')}
      >
        <div {...stylex.props(previewStyles.row15)}>
          <div {...stylex.props(previewStyles.row16)}>
            <Target {...stylex.props(previewStyles.text24)} aria-hidden="true" />
            <span {...stylex.props(previewStyles.text25)}>{copy.label}</span>
            <span {...stylex.props(previewStyles.row17)}>
              <LoaderCircle {...stylex.props(previewStyles.frame7)} aria-hidden="true" />
              {copy.status}
            </span>
          </div>
          <div {...stylex.props(previewStyles.row18)}>
            <GoalAction icon={Pause} label={copy.pause} />
            <GoalAction icon={Play} label={copy.resume} tone="success" muted />
            <GoalAction icon={X} label={copy.clear} tone="danger" />
          </div>
        </div>
        <div {...stylex.props(previewStyles.section14)}>
          <p {...stylex.props(previewStyles.text26)}>{copy.objective}</p>
          <div {...stylex.props(previewStyles.row19)}>
            <span {...stylex.props(previewStyles.row20)}>
              <Clock {...stylex.props(previewStyles.frame7)} aria-hidden="true" />
              {copy.elapsed} {copy.elapsedValue}
            </span>
            <span {...stylex.props(previewStyles.row20)}>
              <Coins {...stylex.props(previewStyles.frame7)} aria-hidden="true" />
              {copy.tokens} {copy.tokensValue}
            </span>
            <span {...stylex.props(previewStyles.row20)}>
              <Gauge {...stylex.props(previewStyles.frame7)} aria-hidden="true" />
              {copy.progress} {copy.progressValue}
            </span>
          </div>
          <div {...stylex.props(previewStyles.frame10)}>
            <div {...stylex.props(previewStyles.frame11)} />
          </div>
        </div>
      </div>
      <p {...stylex.props(previewStyles.text5)}>{copy.caption}</p>
    </div>
  );
}

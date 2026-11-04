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
import { cn } from '../landing-replica/utils';

/* Display-only previews for the docs' runtime reference and Claude/Codex
   capability pages. They replace static screenshots with synthetic data and
   intentionally reuse only site-docs relative primitives plus lucide-react.
   Source markup/copy was copied from the app files named on each component;
   none of these previews import the app, @lody/*, Convex, jotai, or i18next. */

const PREVIEW_SHELL =
  'lody-app-preview overflow-hidden rounded-xl border border-border bg-background text-foreground shadow-sm';
const CAPTION_CLASS = 'mt-2 text-center text-xs text-muted-foreground';

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
    <div className="my-6">
      <div aria-hidden="true" className={cn(PREVIEW_SHELL, 'p-4 sm:p-6')}>
        <div className="mx-auto w-full max-w-[320px]">
          <div className="mb-2 text-base font-semibold tracking-tight sm:text-lg">{copy.title}</div>
          <div className="relative">
            <div className="flex h-11 items-center justify-between rounded-lg border border-input-border bg-card px-3 text-base font-medium shadow-xs">
              <span>{copy.claude}</span>
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="mt-1.5 overflow-hidden rounded-lg border border-border bg-popover shadow-lg">
              <div className="flex items-center justify-between bg-selection px-3 py-2.5 text-base">
                <span>{copy.claude}</span>
                <Check className="h-4 w-4" strokeWidth={2.5} />
              </div>
              <div className="px-3 py-2.5 text-base">{copy.codex}</div>
            </div>
          </div>
        </div>
      </div>
      <p className={CAPTION_CLASS}>{copy.caption}</p>
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
    <div className="my-6">
      <div aria-hidden="true" className={cn(PREVIEW_SHELL, 'p-4 sm:p-6')}>
        <div className="mx-auto w-full max-w-3xl">
          <div className="mb-3 flex items-end justify-between gap-3">
            <div>
              <div className="text-sm font-semibold">{copy.title}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{copy.subtitle}</div>
            </div>
            <span className="rounded-full border border-border px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              ACP
            </span>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {REGISTRY_RUNTIMES.map(({ name, icon: Icon }) => (
              <div
                key={name}
                className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-border/70 bg-card px-3 py-2.5"
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                    <Icon className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <span className="truncate text-sm font-medium">{name}</span>
                </span>
                <span className="shrink-0 rounded-md bg-muted px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {copy.experimental}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <p className={CAPTION_CLASS}>{copy.caption}</p>
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
    <div className="my-6">
      <div aria-hidden="true" className={cn(PREVIEW_SHELL, 'p-4 sm:p-6')}>
        <div className="mx-auto w-full max-w-2xl">
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-2 shadow-sm">
            <ReplicaRunConfigTrigger
              agent="codex"
              modelLabel={copy.model}
              thinkLabel={copy.thinking}
            />
            <span aria-hidden="true" className="h-4 w-px bg-border" />
            <span className="inline-flex h-7 shrink-0 select-none items-center gap-1.5 rounded-[4px] bg-status-success/10 px-2 text-[0.9em] leading-tight text-status-success">
              <Zap className="h-4 w-4 shrink-0" strokeWidth={1.8} aria-hidden="true" />
              <span>{copy.fast}</span>
              <span className="rounded bg-status-success/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase">
                {copy.on}
              </span>
            </span>
          </div>
          <div className="mt-2 flex items-start gap-2 rounded-lg border border-status-success/20 bg-status-success/[0.06] px-3 py-2">
            <Zap className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-success" aria-hidden="true" />
            <p className="text-xs leading-relaxed text-muted-foreground">
              <span className="font-medium text-foreground">{copy.tradeoff}</span> {copy.caption}
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
    <div className="flex min-w-0 flex-col rounded-xl border border-border bg-card p-4 shadow-sm">
      <span className="w-fit rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {question.badge}
      </span>
      <h3 className="mt-2 text-base font-semibold leading-snug">{question.question}</h3>
      <div className="mt-3 flex flex-col gap-1.5">
        {question.options.map((option) => (
          <div
            key={option.label}
            className={cn(
              'flex items-start gap-3 rounded-lg border px-3 py-2',
              option.selected ? 'border-primary/35 bg-primary/[0.04]' : 'border-border/70'
            )}
          >
            <span
              className={cn(
                'mt-0.5 flex size-4 shrink-0 items-center justify-center border',
                multiSelect ? 'rounded-[3px]' : 'rounded-full',
                option.selected
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-input-border bg-background'
              )}
            >
              {option.selected ? (
                multiSelect ? (
                  <Check className="h-3 w-3" strokeWidth={3} />
                ) : (
                  <span className="size-1.5 rounded-full bg-primary-foreground" />
                )
              ) : null}
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium">{option.label}</span>
              <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                {option.description}
              </span>
            </span>
          </div>
        ))}
      </div>
      {question.customPlaceholder ? (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-input-border bg-background px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-xs text-input-placeholder">
            {question.customPlaceholder}
          </span>
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
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
    <div className="my-6">
      <div
        aria-hidden="true"
        className={cn(PREVIEW_SHELL, 'pointer-events-none bg-muted/20 p-4 sm:p-6')}
      >
        <div className="mx-auto grid w-full max-w-3xl gap-4 md:grid-cols-2">
          <AskQuestionCard question={copy.single} multiSelect={false} />
          <AskQuestionCard question={copy.multi} multiSelect />
        </div>
      </div>
      <p className={CAPTION_CLASS}>{copy.caption}</p>
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
      className={cn(
        'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 text-xs font-medium',
        tone === 'neutral' && 'border-border bg-card text-foreground',
        tone === 'success' && 'border-status-success/35 bg-status-success/10 text-status-success',
        tone === 'danger' && 'border-destructive/30 bg-background text-destructive',
        muted && 'opacity-45'
      )}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

/** Static Codex-style goal banner with objective, usage and state controls. */
export function GoalPreview({ locale = 'en' }: PreviewProps) {
  const copy = GOAL_COPY[locale];
  return (
    <div className="my-6">
      <div aria-hidden="true" className={cn(PREVIEW_SHELL, 'bg-status-info/10')}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-status-info/30 px-3 py-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Target className="h-4 w-4 shrink-0 text-status-info" aria-hidden="true" />
            <span className="text-[11px] font-semibold uppercase tracking-wide text-status-info">
              {copy.label}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full border border-status-info/30 bg-background/70 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-status-info">
              <LoaderCircle className="h-3 w-3" aria-hidden="true" />
              {copy.status}
            </span>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            <GoalAction icon={Pause} label={copy.pause} />
            <GoalAction icon={Play} label={copy.resume} tone="success" muted />
            <GoalAction icon={X} label={copy.clear} tone="danger" />
          </div>
        </div>
        <div className="px-3 pb-3 pt-2">
          <p className="text-sm font-medium leading-snug">{copy.objective}</p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3 w-3" aria-hidden="true" />
              {copy.elapsed} {copy.elapsedValue}
            </span>
            <span className="inline-flex items-center gap-1">
              <Coins className="h-3 w-3" aria-hidden="true" />
              {copy.tokens} {copy.tokensValue}
            </span>
            <span className="inline-flex items-center gap-1">
              <Gauge className="h-3 w-3" aria-hidden="true" />
              {copy.progress} {copy.progressValue}
            </span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-background/80">
            <div className="h-full w-1/4 rounded-full bg-status-info" />
          </div>
        </div>
      </div>
      <p className={CAPTION_CLASS}>{copy.caption}</p>
    </div>
  );
}

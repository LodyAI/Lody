/**
 * Docs-owned, display-only previews for the Settings reference pages. These
 * replace the former static screenshots for:
 *
 * - Subscription quota → `QuotaPreview`
 * - Token usage and estimated cost → `UsagePreview`
 * - Browser permission prompt / mobile OS notification banner
 *   → `NotificationPreview` (browser + mobile variants)
 *
 * The markup is copied/inspired from the app surfaces named in each component
 * comment below, but this file never imports app runtime code (`@/*`,
 * `@lody/*`, Convex, jotai, i18next, …). Data is synthetic and every preview
 * renders completely in prerendered HTML; see `site-docs/AGENTS.md` →
 * "Product replica boundary".
 */

import { Bell, Coins, DollarSign, Pencil, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { AnthropicIcon, OpenAIIcon } from '../landing-replica/icons';
import type { ReplicaLocale } from '../landing-replica/types';
import { cn } from '../landing-replica/utils';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type PreviewProps = { locale?: ReplicaLocale };

function formatCompact(value: number, locale: ReplicaLocale): string {
  return new Intl.NumberFormat(locale === 'zh' ? 'zh-CN' : 'en', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

function formatUsd(value: number, locale: ReplicaLocale): string {
  return new Intl.NumberFormat(locale === 'zh' ? 'zh-CN' : 'en', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function PreviewFrame({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div
      aria-hidden="true"
      aria-label={label}
      className="lody-app-preview overflow-hidden rounded-xl border border-border bg-background text-foreground shadow-sm"
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// QuotaPreview — Settings → Agent Config → Machines (rate-limit.png)
// ---------------------------------------------------------------------------

type QuotaWindowCopy = {
  label: string;
  percent: number;
  reset: string;
};

type QuotaProviderCopy = {
  name: string;
  windows: [QuotaWindowCopy, QuotaWindowCopy];
};

type QuotaCopy = {
  caption: string;
  machines: string;
  myMachines: string;
  otherMachines: string;
  machineName: string;
  machineMeta: string;
  otherMachineName: string;
  otherMachineMeta: string;
  owner: string;
  claude: QuotaProviderCopy;
  codex: QuotaProviderCopy;
};

const QUOTA_COPY: Record<ReplicaLocale, QuotaCopy> = {
  en: {
    caption:
      'Mock data illustration. Claude Code and Codex subscription quota windows for machines running the Lody CLI.',
    machines: 'Machines',
    myMachines: 'My Machines',
    otherMachines: 'Other Machines',
    machineName: 'machine',
    machineMeta: 'linux | v0.31.13-next.1',
    otherMachineName: 'jimmy',
    otherMachineMeta: 'linux | v0.31.6-next.1',
    owner: 'Owner: Zixuan Chen',
    claude: {
      name: 'Claude',
      windows: [
        { label: '5h', percent: 90, reset: 'Resets in 10h' },
        { label: '7d', percent: 98, reset: 'Resets in 6d' },
      ],
    },
    codex: {
      name: 'Codex',
      windows: [
        { label: '5h', percent: 100, reset: 'Resets in 5h' },
        { label: '7d', percent: 100, reset: 'Resets in 5d' },
      ],
    },
  },
  zh: {
    caption: '模拟数据示意。已运行 Lody CLI 的机器上，Claude Code 与 Codex 的订阅额度窗口。',
    machines: '机器',
    myMachines: '我的机器',
    otherMachines: '其他机器',
    machineName: 'machine',
    machineMeta: 'linux | v0.31.13-next.1',
    otherMachineName: 'jimmy',
    otherMachineMeta: 'linux | v0.31.6-next.1',
    owner: '所有者：Zixuan Chen',
    claude: {
      name: 'Claude',
      windows: [
        { label: '5h', percent: 90, reset: '10 小时后重置' },
        { label: '7d', percent: 98, reset: '6 天后重置' },
      ],
    },
    codex: {
      name: 'Codex',
      windows: [
        { label: '5h', percent: 100, reset: '5 小时后重置' },
        { label: '7d', percent: 100, reset: '5 天后重置' },
      ],
    },
  },
};

function MachineIdentity({
  name,
  meta,
  editable = false,
}: {
  name: string;
  meta: string;
  editable?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      <span
        aria-hidden="true"
        className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-status-success"
      />
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-medium text-foreground">{name}</span>
          {editable ? (
            <Pencil aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : null}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{meta}</p>
      </div>
    </div>
  );
}

function QuotaWindowRow({ window }: { window: QuotaWindowCopy }) {
  const percent = Math.min(100, Math.max(0, window.percent));
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-1.5 text-[11px] leading-none">
        <span className="shrink-0 font-medium text-foreground/80">{window.label}</span>
        <span className="relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
          <span
            className="absolute inset-y-0 left-0 rounded-full bg-muted-foreground/70"
            style={{ width: `${percent}%` }}
          />
        </span>
        <span className="w-8 shrink-0 text-right tabular-nums text-foreground">
          {window.percent}%
        </span>
      </div>
      <p
        className="mt-1 truncate text-[10px] leading-none text-muted-foreground"
        title={window.reset}
      >
        {window.reset}
      </p>
    </div>
  );
}

function ProviderQuotaCard({ provider }: { provider: QuotaProviderCopy }) {
  const Icon = provider.name === 'Claude' ? AnthropicIcon : OpenAIIcon;
  return (
    <div className="min-w-0 rounded-lg border border-border bg-card px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-xs font-medium text-card-foreground">
        <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span>{provider.name}</span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
        {provider.windows.map((window) => (
          <QuotaWindowRow key={window.label} window={window} />
        ))}
      </div>
    </div>
  );
}

/**
 * Display-only replica of the Machines quota section: the machine list shape
 * copied from `account-machines-overview.tsx`, the per-provider quota block
 * copied from `machine-quota-compact.tsx`, and the compact 5h/7d meter layout
 * from `provider-row.tsx`. The surrounding pane/detail structure follows
 * `machine-detail-pane.tsx` and the `MachineDetailPane` story.
 */
export function QuotaPreview({ locale = 'en' }: PreviewProps) {
  const copy = QUOTA_COPY[locale];

  return (
    <div className="my-6">
      <PreviewFrame label={copy.caption}>
        <div className="border-b border-border px-4 py-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {copy.machines}
          </p>
        </div>

        <div className="px-4 py-3">
          <p className="text-sm font-medium text-foreground">{copy.myMachines}</p>
          <div className="mt-3 flex flex-col gap-3 lg:flex-row lg:items-start lg:gap-6">
            <div className="shrink-0 lg:w-52">
              <MachineIdentity name={copy.machineName} meta={copy.machineMeta} editable />
            </div>
            <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-2">
              <ProviderQuotaCard provider={copy.claude} />
              <ProviderQuotaCard provider={copy.codex} />
            </div>
          </div>
        </div>

        <div className="border-t border-border px-4 py-3">
          <p className="text-sm font-medium text-foreground">{copy.otherMachines}</p>
          <div className="mt-2">
            <MachineIdentity
              name={copy.otherMachineName}
              meta={`${copy.otherMachineMeta} · ${copy.owner}`}
            />
          </div>
        </div>
      </PreviewFrame>
      <p className="mt-2 text-center text-xs text-muted-foreground">{copy.caption}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// UsagePreview — Settings → Stats (0304-token-usage.png)
// ---------------------------------------------------------------------------

type UsageCopy = {
  caption: string;
  workspace: string;
  rangeLabels: Record<'day' | 'week' | 'month' | 'total', string>;
  tokens: string;
  cost: string;
  byModel: string;
};

const USAGE_COPY: Record<ReplicaLocale, UsageCopy> = {
  en: {
    caption:
      'Mock data illustration. Token and cost totals in Settings → Stats, with a by-model usage chart.',
    workspace: 'lody',
    rangeLabels: { day: 'Day', week: 'Week', month: 'Month', total: 'Total' },
    tokens: 'Tokens',
    cost: 'Cost (USD)',
    byModel: 'By model',
  },
  zh: {
    caption: '模拟数据示意。设置 → Stats 中的 Token 与费用统计，以及按模型的用量图表。',
    workspace: 'lody',
    rangeLabels: { day: '日', week: '周', month: '月', total: '全部' },
    tokens: 'Token',
    cost: '费用 (USD)',
    byModel: '按模型',
  },
};

const USAGE_MODELS = [
  { id: 'gpt-5.3-codex', label: 'gpt-5.3-codex/xhigh', color: '#2563eb', weight: 0.52 },
  { id: 'claude-opus-4-6', label: 'claude-opus-4-6', color: '#0ea5e9', weight: 0.15 },
  { id: 'gpt-5.2-xhigh', label: 'gpt-5.2/xhigh', color: '#06b6d4', weight: 0.12 },
  { id: 'gpt-5.2-high', label: 'gpt-5.2/high', color: '#10b981', weight: 0.08 },
  { id: 'claude-haiku-4-5', label: 'claude-haiku-4-5', color: '#f59e0b', weight: 0.08 },
  { id: 'other', label: 'Other', color: '#6b7280', weight: 0.05 },
] as const;

const USAGE_BUCKET_LABELS = ['2/25', '2/26', '2/27', '2/28', '3/1', '3/2', '3/3', '3/4'] as const;

/** Deterministic "mostly flat, one peak" shape, mirroring the reference image. */
const USAGE_BUCKET_SHAPE = [0.31, 0.3, 0.23, 1, 0.74, 0.33, 0.13, 0.05] as const;
const USAGE_PEAK_TOKENS = 1_000_000_000;

const USAGE_BUCKETS = USAGE_BUCKET_LABELS.map((label, bucketIndex) => {
  const values = USAGE_MODELS.map((model) =>
    Math.round(USAGE_PEAK_TOKENS * USAGE_BUCKET_SHAPE[bucketIndex] * model.weight)
  );
  return { label, values, total: values.reduce((sum, value) => sum + value, 0) };
});

const USAGE_MODEL_TOTALS = USAGE_MODELS.map((model, modelIndex) => ({
  ...model,
  total: USAGE_BUCKETS.reduce((sum, bucket) => sum + bucket.values[modelIndex], 0),
}));

const USAGE_TOTAL_TOKENS = USAGE_MODEL_TOTALS.reduce((sum, model) => sum + model.total, 0);
/** At the reference blend, one million tokens costs roughly one dollar. */
const USAGE_TOTAL_COST = USAGE_TOTAL_TOKENS / 1_000_000;

function niceCeil(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const nice =
    normalized <= 1
      ? 1
      : normalized <= 1.2
        ? 1.2
        : normalized <= 1.5
          ? 1.5
          : normalized <= 2
            ? 2
            : normalized <= 2.5
              ? 2.5
              : normalized <= 3
                ? 3
                : normalized <= 4
                  ? 4
                  : normalized <= 5
                    ? 5
                    : normalized <= 6
                      ? 6
                      : normalized <= 8
                        ? 8
                        : 10;
  return nice * magnitude;
}

type UsageChart = {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  yMax: number;
  yTicks: number[];
  xTicks: { label: string; x: number }[];
  areas: { id: string; color: string; areaPath: string; linePath: string }[];
};

function buildUsageChart(): UsageChart {
  const width = 640;
  const height = 220;
  const left = 54;
  const right = 16;
  const top = 10;
  const bottom = 28;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;

  const bucketCount = USAGE_BUCKETS.length;
  const maxBucket = Math.max(...USAGE_BUCKETS.map((bucket) => bucket.total));
  const yMax = niceCeil(maxBucket * 1.05);

  const xFor = (index: number) =>
    bucketCount <= 1 ? left + plotWidth / 2 : left + (index / (bucketCount - 1)) * plotWidth;
  const yFor = (value: number) => top + plotHeight - (value / yMax) * plotHeight;

  const yTicks = Array.from({ length: 5 }, (_, index) => (yMax * index) / 4);
  const xTicks = USAGE_BUCKETS.map((bucket, index) => ({
    label: bucket.label,
    x: xFor(index),
  }));

  const running = USAGE_BUCKETS.map(() => 0);
  const areas = USAGE_MODELS.map((model, modelIndex) => {
    const bottoms = running.slice();
    const tops = running.map(
      (accumulated, bucketIndex) => accumulated + USAGE_BUCKETS[bucketIndex].values[modelIndex]
    );
    for (let index = 0; index < tops.length; index += 1) running[index] = tops[index];

    const upper = tops.map((value, index) => `${xFor(index)},${yFor(value)}`);
    const lower = bottoms.map((value, index) => `${xFor(index)},${yFor(value)}`).reverse();

    return {
      id: model.id,
      color: model.color,
      areaPath: `M ${upper.join(' L ')} L ${lower.join(' L ')} Z`,
      linePath: `M ${upper.join(' L ')}`,
    };
  });

  return { width, height, left, right, top, bottom, yMax, yTicks, xTicks, areas };
}

const USAGE_CHART = buildUsageChart();

function UsageRangeTabs({ copy }: { copy: UsageCopy }) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-lg border border-border/60 bg-muted/40 p-0.5">
      {(['day', 'week', 'month', 'total'] as const).map((range) => (
        <span
          key={range}
          className={cn(
            'rounded-md px-2.5 py-1 text-xs',
            range === 'total' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'
          )}
        >
          {copy.rangeLabels[range]}
        </span>
      ))}
    </div>
  );
}

function UsageKpiCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon: 'tokens' | 'cost';
}) {
  const Icon = icon === 'tokens' ? Coins : DollarSign;
  return (
    <div className="relative min-w-0 overflow-hidden rounded-lg border border-border/70 bg-card/60 p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-2 truncate text-2xl font-normal tracking-tight tabular-nums text-foreground sm:text-3xl">
        {value}
      </p>
      <Icon
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-8 -right-8 h-28 w-28 text-muted-foreground/[0.08]"
      />
    </div>
  );
}

function UsageStackedAreaChart({ locale }: { locale: ReplicaLocale }) {
  const chart = USAGE_CHART;
  const formatAxis = (value: number) => formatCompact(value, locale);

  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${chart.width} ${chart.height}`}
      className="block h-auto w-full"
    >
      <defs>
        {chart.areas.map((area, index) => (
          <linearGradient key={area.id} id={`docs-usage-area-${index}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={area.color} stopOpacity="0.42" />
            <stop offset="100%" stopColor={area.color} stopOpacity="0.08" />
          </linearGradient>
        ))}
      </defs>

      {chart.yTicks.map((tick) => {
        const y = chart.top + (1 - tick / chart.yMax) * (chart.height - chart.top - chart.bottom);
        return (
          <g key={tick}>
            <line
              x1={chart.left}
              x2={chart.width - chart.right}
              y1={y}
              y2={y}
              stroke="hsl(var(--border))"
              strokeOpacity="0.45"
            />
            <text
              x={chart.left - 8}
              y={y + 3}
              textAnchor="end"
              fill="hsl(var(--muted-foreground))"
              fontSize="10"
            >
              {formatAxis(tick)}
            </text>
          </g>
        );
      })}

      {chart.xTicks.map((tick) => (
        <text
          key={tick.label}
          x={tick.x}
          y={chart.height - 8}
          textAnchor="middle"
          fill="hsl(var(--muted-foreground))"
          fontSize="10"
        >
          {tick.label}
        </text>
      ))}

      {chart.areas.map((area, index) => (
        <g key={area.id}>
          <path d={area.areaPath} fill={`url(#docs-usage-area-${index})`} />
          <path
            d={area.linePath}
            fill="none"
            stroke={area.color}
            strokeOpacity="0.9"
            strokeWidth="1.25"
            strokeLinejoin="round"
          />
        </g>
      ))}
    </svg>
  );
}

/**
 * Compact, display-only replica of the Settings → Stats usage page. The KPI
 * cards, range tabs, and stacked model legend follow `stats-setting-pure.tsx`;
 * the chart follows the stacked-area shape from `usage-stacked-area-chart.tsx`.
 * The heavier calendar/skyline (`usage-calendar-visualization.tsx`) is omitted
 * so the preview stays compact and purely server-renderable.
 */
export function UsagePreview({ locale = 'en' }: PreviewProps) {
  const copy = USAGE_COPY[locale];
  const modelTotals = USAGE_MODEL_TOTALS.map((model) => ({
    ...model,
    formattedTotal: formatCompact(model.total, locale),
  }));

  return (
    <div className="my-6">
      <PreviewFrame label={copy.caption}>
        <div className="flex flex-wrap items-end justify-between gap-3 px-4 pb-1 pt-4">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">{copy.workspace}</p>
          </div>
          <UsageRangeTabs copy={copy} />
        </div>

        <div className="grid grid-cols-2 gap-3 px-4 py-3">
          <UsageKpiCard
            icon="tokens"
            label={copy.tokens}
            value={formatCompact(USAGE_TOTAL_TOKENS, locale)}
          />
          <UsageKpiCard icon="cost" label={copy.cost} value={formatUsd(USAGE_TOTAL_COST, locale)} />
        </div>

        <div className="border-t border-border/60 px-4 pb-3 pt-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {copy.byModel}
          </p>
          <div className="mt-2">
            <UsageStackedAreaChart locale={locale} />
          </div>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1.5 border-t border-border/60 pt-2">
            {modelTotals.map((model) => (
              <span key={model.id} className="inline-flex min-w-0 items-center gap-1.5 text-xs">
                <span
                  aria-hidden="true"
                  className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
                  style={{ backgroundColor: model.color }}
                />
                <span className="max-w-[180px] truncate text-muted-foreground">{model.label}</span>
                <span className="shrink-0 tabular-nums text-foreground">
                  {model.formattedTotal}
                </span>
              </span>
            ))}
          </div>
        </div>
      </PreviewFrame>
      <p className="mt-2 text-center text-xs text-muted-foreground">{copy.caption}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// NotificationPreview — General → Push Notifications
// ---------------------------------------------------------------------------

type BrowserNotificationCopy = {
  title: string;
  prompt: string;
  block: string;
  allow: string;
  caption: string;
};

type MobileNotificationCopy = {
  app: string;
  title: string;
  body: string;
  now: string;
  caption: string;
};

type NotificationCopy = {
  browser: BrowserNotificationCopy;
  mobile: MobileNotificationCopy;
};

const NOTIFICATION_COPY: Record<ReplicaLocale, NotificationCopy> = {
  en: {
    browser: {
      title: 'lody.ai wants to',
      prompt: 'Show notifications',
      block: 'Block',
      allow: 'Allow',
      caption:
        'Representative browser permission prompt. Browsers own this dialog; it is not part of the Lody app.',
    },
    mobile: {
      app: 'from Lody',
      title: 'Reduce title font size',
      body: 'Pull Request #215 is ready to review',
      now: 'now',
      caption:
        'Representative iOS notification banner. The operating system owns this banner; it is not part of the Lody app.',
    },
  },
  zh: {
    browser: {
      title: 'lody.ai 想要',
      prompt: '显示通知',
      block: '屏蔽',
      allow: '允许',
      caption: '模拟浏览器通知授权提示。该弹窗由浏览器提供，并非 Lody 应用界面。',
    },
    mobile: {
      app: '来自 Lody',
      title: '缩小标题字号',
      body: 'Pull Request #215 已可审查',
      now: '现在',
      caption: '模拟 iOS 通知横幅。该横幅由操作系统提供，并非 Lody 应用界面。',
    },
  },
};

function BrowserNotificationPreview({ locale }: { locale: ReplicaLocale }) {
  const copy = NOTIFICATION_COPY[locale].browser;
  return (
    <div className="inline-block w-full max-w-sm overflow-hidden rounded-xl border border-border bg-card p-3 text-card-foreground shadow-lg">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 truncate text-sm font-semibold">{copy.title}</p>
        <X aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Bell aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="text-sm">{copy.prompt}</span>
      </div>
      <div className="mt-4 flex items-center justify-end gap-2">
        <span className="rounded-full border border-border px-4 py-1.5 text-sm text-foreground">
          {copy.block}
        </span>
        <span className="rounded-full bg-primary px-4 py-1.5 text-sm text-primary-foreground">
          {copy.allow}
        </span>
      </div>
    </div>
  );
}

function MobileNotificationPreview({ locale }: { locale: ReplicaLocale }) {
  const copy = NOTIFICATION_COPY[locale].mobile;
  return (
    <div className="mx-auto flex w-full max-w-md items-center gap-3 rounded-[20px] border border-border/70 bg-card/95 p-3 text-card-foreground shadow-lg backdrop-blur">
      <img
        src="/_docs-assets/logo-96.png"
        alt=""
        width={44}
        height={44}
        className="h-11 w-11 shrink-0 rounded-[10px] bg-[#07131f] object-contain p-1"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <p className="truncate text-sm font-semibold">{copy.title}</p>
          <span className="shrink-0 text-[11px] text-muted-foreground">{copy.now}</span>
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{copy.app}</p>
        <p className="mt-0.5 line-clamp-2 text-xs text-card-foreground">{copy.body}</p>
      </div>
    </div>
  );
}

/**
 * Display-only mock of the two OS/browser notification surfaces used by the
 * Notifications guide. Neither variant is an app component: the browser prompt
 * is browser chrome and the mobile variant is an iOS/Android system banner.
 * Copy and the app mark are synthetic; the Lody mark is the tracked
 * `/_docs-assets/logo-96.png` asset.
 */
export function NotificationPreview({
  locale = 'en',
  variant = 'browser',
}: PreviewProps & { variant?: 'browser' | 'mobile' }) {
  const copy = NOTIFICATION_COPY[locale][variant];
  return (
    <div className="my-6">
      <PreviewFrame label={copy.caption}>
        <div className="px-4 py-5 sm:px-6">
          {variant === 'browser' ? (
            <BrowserNotificationPreview locale={locale} />
          ) : (
            <MobileNotificationPreview locale={locale} />
          )}
        </div>
      </PreviewFrame>
      <p className="mt-2 text-center text-xs text-muted-foreground">{copy.caption}</p>
    </div>
  );
}

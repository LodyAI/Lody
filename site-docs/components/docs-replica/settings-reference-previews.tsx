import * as stylex from '@stylexjs/stylex';
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
const previewStyles = stylex.create({
  rangeTab: {
    borderRadius: 'var(--radius-md)',
    paddingInline: 'calc(var(--spacing) * 2.5)',
    paddingBlock: 'var(--spacing)',
    fontSize: 'var(--text-xs)',
    lineHeight: 'var(--text-xs--line-height)',
  },
  rangeSelected: {
    backgroundColor: 'hsl(var(--background))',
    color: 'hsl(var(--foreground))',
    boxShadow: '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, var(--shadow-sm)',
  },
  rangeIdle: { color: 'hsl(var(--muted-foreground))' },
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
  row: {
    display: 'flex',
    'min-width': '0px',
    'align-items': 'flex-start',
    gap: 'calc(var(--spacing) * 2)',
  },
  frame: {
    'margin-top': '7px',
    height: 'calc(var(--spacing) * 1.5)',
    width: 'calc(var(--spacing) * 1.5)',
    'flex-shrink': '0',
    'border-radius': 'calc(infinity * 1px)',
    'background-color': 'hsl(var(--status-success))',
  },
  section: {
    'min-width': '0px',
  },
  row2: {
    display: 'flex',
    'min-width': '0px',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 1.5)',
  },
  text2: {
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
    'font-weight': 'var(--font-weight-medium)',
    color: 'hsl(var(--foreground))',
  },
  text3: {
    height: 'calc(var(--spacing) * 3.5)',
    width: 'calc(var(--spacing) * 3.5)',
    'flex-shrink': '0',
    color: 'hsl(var(--muted-foreground))',
  },
  text4: {
    'margin-top': 'calc(var(--spacing) * 0.5)',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    color: 'hsl(var(--muted-foreground))',
  },
  row3: {
    display: 'flex',
    'min-width': '0px',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 1.5)',
    'font-size': '11px',
    'line-height': '1',
  },
  text5: {
    'flex-shrink': '0',
    'font-weight': 'var(--font-weight-medium)',
    color: 'color-mix(in oklab, hsl(var(--foreground)) 80%, transparent)',
  },
  frame2: {
    position: 'relative',
    height: 'calc(var(--spacing) * 1.5)',
    'min-width': '0px',
    flex: '1',
    overflow: 'hidden',
    'border-radius': 'calc(infinity * 1px)',
    'background-color': 'hsl(var(--muted))',
  },
  overlay: {
    position: 'absolute',
    'inset-block': '0px',
    left: '0px',
    'border-radius': 'calc(infinity * 1px)',
    'background-color': 'color-mix(in oklab, hsl(var(--muted-foreground)) 70%, transparent)',
  },
  text6: {
    width: 'calc(var(--spacing) * 8)',
    'flex-shrink': '0',
    'text-align': 'right',
    color: 'hsl(var(--foreground))',
    'font-variant-numeric': 'tabular-nums',
  },
  text7: {
    'margin-top': 'var(--spacing)',
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
    'font-size': '10px',
    'line-height': '1',
    color: 'hsl(var(--muted-foreground))',
  },
  section2: {
    'min-width': '0px',
    'border-radius': 'var(--radius-lg)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'hsl(var(--border))',
    'background-color': 'hsl(var(--card))',
    'padding-inline': 'calc(var(--spacing) * 3)',
    'padding-block': 'calc(var(--spacing) * 2.5)',
  },
  row4: {
    display: 'flex',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 1.5)',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    'font-weight': 'var(--font-weight-medium)',
    color: 'hsl(var(--card-foreground))',
  },
  grid: {
    'margin-top': 'calc(var(--spacing) * 2)',
    display: 'grid',
    'grid-template-columns': 'repeat(2, minmax(0, 1fr))',
    'column-gap': 'calc(var(--spacing) * 3)',
    'row-gap': 'var(--spacing)',
  },
  section3: {
    'margin-block': 'calc(var(--spacing) * 6)',
  },
  section4: {
    'border-bottom-style': 'solid',
    'border-bottom-width': '1px',
    'border-color': 'hsl(var(--border))',
    'padding-inline': 'calc(var(--spacing) * 4)',
    'padding-block': 'calc(var(--spacing) * 2)',
  },
  text8: {
    'font-size': '11px',
    'font-weight': 'var(--font-weight-semibold)',
    'letter-spacing': '0.12em',
    color: 'hsl(var(--muted-foreground))',
    'text-transform': 'uppercase',
  },
  section5: {
    'padding-inline': 'calc(var(--spacing) * 4)',
    'padding-block': 'calc(var(--spacing) * 3)',
  },
  text9: {
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
    'font-weight': 'var(--font-weight-medium)',
    color: 'hsl(var(--foreground))',
  },
  stack: {
    'margin-top': 'calc(var(--spacing) * 3)',
    display: 'flex',
    'flex-direction': 'column',
    gap: 'calc(var(--spacing) * 3)',
    '@media (width >= 64rem)': {
      'flex-direction': 'row',
      'align-items': 'flex-start',
      gap: 'calc(var(--spacing) * 6)',
    },
  },
  section6: {
    'flex-shrink': '0',
    '@media (width >= 64rem)': {
      width: 'calc(var(--spacing) * 52)',
    },
  },
  grid2: {
    display: 'grid',
    'min-width': '0px',
    flex: '1',
    gap: 'calc(var(--spacing) * 2)',
    '@media (width >= 40rem)': {
      'grid-template-columns': 'repeat(2, minmax(0, 1fr))',
    },
  },
  section7: {
    'border-top-style': 'solid',
    'border-top-width': '1px',
    'border-color': 'hsl(var(--border))',
    'padding-inline': 'calc(var(--spacing) * 4)',
    'padding-block': 'calc(var(--spacing) * 3)',
  },
  section8: {
    'margin-top': 'calc(var(--spacing) * 2)',
  },
  text10: {
    'margin-top': 'calc(var(--spacing) * 2)',
    'text-align': 'center',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    color: 'hsl(var(--muted-foreground))',
  },
  row5: {
    display: 'inline-flex',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 0.5)',
    'border-radius': 'var(--radius-lg)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'color-mix(in oklab, hsl(var(--border)) 60%, transparent)',
    'background-color': 'color-mix(in oklab, hsl(var(--muted)) 40%, transparent)',
    padding: 'calc(var(--spacing) * 0.5)',
  },
  section9: {
    position: 'relative',
    'min-width': '0px',
    overflow: 'hidden',
    'border-radius': 'var(--radius-lg)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'color-mix(in oklab, hsl(var(--border)) 70%, transparent)',
    'background-color': 'color-mix(in oklab, hsl(var(--card)) 60%, transparent)',
    padding: 'calc(var(--spacing) * 4)',
  },
  text11: {
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    color: 'hsl(var(--muted-foreground))',
  },
  text12: {
    'margin-top': 'calc(var(--spacing) * 2)',
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
    'font-size': 'var(--text-2xl)',
    'line-height': 'var(--text-2xl--line-height)',
    'font-weight': 'var(--font-weight-normal)',
    'letter-spacing': 'var(--tracking-tight)',
    color: 'hsl(var(--foreground))',
    'font-variant-numeric': 'tabular-nums',
    '@media (width >= 40rem)': {
      'font-size': 'var(--text-3xl)',
      'line-height': 'var(--text-3xl--line-height)',
    },
  },
  overlay2: {
    'pointer-events': 'none',
    position: 'absolute',
    right: 'calc(var(--spacing) * -8)',
    bottom: 'calc(var(--spacing) * -8)',
    height: 'calc(var(--spacing) * 28)',
    width: 'calc(var(--spacing) * 28)',
    color: 'color-mix(in oklab, hsl(var(--muted-foreground)) 8%, transparent)',
  },
  frame3: {
    display: 'block',
    height: 'auto',
    width: '100%',
  },
  row6: {
    display: 'flex',
    'flex-wrap': 'wrap',
    'align-items': 'flex-end',
    'justify-content': 'space-between',
    gap: 'calc(var(--spacing) * 3)',
    'padding-inline': 'calc(var(--spacing) * 4)',
    'padding-top': 'calc(var(--spacing) * 4)',
    'padding-bottom': 'var(--spacing)',
  },
  grid3: {
    display: 'grid',
    'grid-template-columns': 'repeat(2, minmax(0, 1fr))',
    gap: 'calc(var(--spacing) * 3)',
    'padding-inline': 'calc(var(--spacing) * 4)',
    'padding-block': 'calc(var(--spacing) * 3)',
  },
  section10: {
    'border-top-style': 'solid',
    'border-top-width': '1px',
    'border-color': 'color-mix(in oklab, hsl(var(--border)) 60%, transparent)',
    'padding-inline': 'calc(var(--spacing) * 4)',
    'padding-top': 'calc(var(--spacing) * 2)',
    'padding-bottom': 'calc(var(--spacing) * 3)',
  },
  row7: {
    'margin-top': 'calc(var(--spacing) * 2)',
    display: 'flex',
    'flex-wrap': 'wrap',
    'column-gap': 'calc(var(--spacing) * 3)',
    'row-gap': 'calc(var(--spacing) * 1.5)',
    'border-top-style': 'solid',
    'border-top-width': '1px',
    'border-color': 'color-mix(in oklab, hsl(var(--border)) 60%, transparent)',
    'padding-top': 'calc(var(--spacing) * 2)',
  },
  row8: {
    display: 'inline-flex',
    'min-width': '0px',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 1.5)',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
  },
  frame4: {
    height: 'calc(var(--spacing) * 2.5)',
    width: 'calc(var(--spacing) * 2.5)',
    'flex-shrink': '0',
    'border-radius': '3px',
  },
  text13: {
    'max-width': '180px',
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
    color: 'hsl(var(--muted-foreground))',
  },
  text14: {
    'flex-shrink': '0',
    color: 'hsl(var(--foreground))',
    'font-variant-numeric': 'tabular-nums',
  },
  text15: {
    display: 'inline-block',
    width: '100%',
    'max-width': 'var(--container-sm)',
    overflow: 'hidden',
    'border-radius': 'var(--radius-xl)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'hsl(var(--border))',
    'background-color': 'hsl(var(--card))',
    padding: 'calc(var(--spacing) * 3)',
    color: 'hsl(var(--card-foreground))',
    'box-shadow': '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, var(--shadow-lg)',
  },
  row9: {
    display: 'flex',
    'align-items': 'flex-start',
    'justify-content': 'space-between',
    gap: 'calc(var(--spacing) * 3)',
  },
  text16: {
    'min-width': '0px',
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
    'font-weight': 'var(--font-weight-semibold)',
  },
  text17: {
    'margin-top': 'calc(var(--spacing) * 0.5)',
    height: 'calc(var(--spacing) * 4)',
    width: 'calc(var(--spacing) * 4)',
    'flex-shrink': '0',
    color: 'hsl(var(--muted-foreground))',
  },
  row10: {
    'margin-top': 'calc(var(--spacing) * 3)',
    display: 'flex',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 2)',
  },
  text18: {
    height: 'calc(var(--spacing) * 4)',
    width: 'calc(var(--spacing) * 4)',
    'flex-shrink': '0',
    color: 'hsl(var(--muted-foreground))',
  },
  text19: {
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
  },
  row11: {
    'margin-top': 'calc(var(--spacing) * 4)',
    display: 'flex',
    'align-items': 'center',
    'justify-content': 'flex-end',
    gap: 'calc(var(--spacing) * 2)',
  },
  text20: {
    'border-radius': 'calc(infinity * 1px)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'hsl(var(--border))',
    'padding-inline': 'calc(var(--spacing) * 4)',
    'padding-block': 'calc(var(--spacing) * 1.5)',
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
    color: 'hsl(var(--foreground))',
  },
  text21: {
    'border-radius': 'calc(infinity * 1px)',
    'background-color': 'hsl(var(--primary))',
    'padding-inline': 'calc(var(--spacing) * 4)',
    'padding-block': 'calc(var(--spacing) * 1.5)',
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
    color: 'hsl(var(--primary-foreground))',
  },
  row12: {
    'margin-inline': 'auto',
    display: 'flex',
    width: '100%',
    'max-width': 'var(--container-md)',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 3)',
    'border-radius': '20px',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'color-mix(in oklab, hsl(var(--border)) 70%, transparent)',
    'background-color': 'color-mix(in oklab, hsl(var(--card)) 95%, transparent)',
    padding: 'calc(var(--spacing) * 3)',
    color: 'hsl(var(--card-foreground))',
    'box-shadow': '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, var(--shadow-lg)',
    'backdrop-filter': 'blur(8px)',
  },
  frame5: {
    height: 'calc(var(--spacing) * 11)',
    width: 'calc(var(--spacing) * 11)',
    'flex-shrink': '0',
    'border-radius': '10px',
    'background-color': '#07131f',
    'object-fit': 'contain',
    padding: 'var(--spacing)',
  },
  section11: {
    'min-width': '0px',
    flex: '1',
  },
  row13: {
    display: 'flex',
    'align-items': 'baseline',
    'justify-content': 'space-between',
    gap: 'calc(var(--spacing) * 2)',
  },
  text22: {
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
    'font-weight': 'var(--font-weight-semibold)',
  },
  text23: {
    'flex-shrink': '0',
    'font-size': '11px',
    color: 'hsl(var(--muted-foreground))',
  },
  text24: {
    'margin-top': 'calc(var(--spacing) * 0.5)',
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    color: 'hsl(var(--muted-foreground))',
  },
  text25: {
    'margin-top': 'calc(var(--spacing) * 0.5)',
    overflow: 'hidden',
    display: '-webkit-box',
    '-webkit-box-orient': 'vertical',
    '-webkit-line-clamp': '2',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    color: 'hsl(var(--card-foreground))',
  },
  section12: {
    'padding-inline': 'calc(var(--spacing) * 4)',
    'padding-block': 'calc(var(--spacing) * 5)',
    '@media (width >= 40rem)': {
      'padding-inline': 'calc(var(--spacing) * 6)',
    },
  },
});

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
      className={['lody-app-preview', stylex.props(previewStyles.text).className].join(' ')}
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
    <div {...stylex.props(previewStyles.row)}>
      <span aria-hidden="true" {...stylex.props(previewStyles.frame)} />
      <div {...stylex.props(previewStyles.section)}>
        <div {...stylex.props(previewStyles.row2)}>
          <span {...stylex.props(previewStyles.text2)}>{name}</span>
          {editable ? <Pencil aria-hidden="true" {...stylex.props(previewStyles.text3)} /> : null}
        </div>
        <p {...stylex.props(previewStyles.text4)}>{meta}</p>
      </div>
    </div>
  );
}

function QuotaWindowRow({ window }: { window: QuotaWindowCopy }) {
  const percent = Math.min(100, Math.max(0, window.percent));
  return (
    <div {...stylex.props(previewStyles.section)}>
      <div {...stylex.props(previewStyles.row3)}>
        <span {...stylex.props(previewStyles.text5)}>{window.label}</span>
        <span {...stylex.props(previewStyles.frame2)}>
          <span {...stylex.props(previewStyles.overlay)} style={{ width: `${percent}%` }} />
        </span>
        <span {...stylex.props(previewStyles.text6)}>{window.percent}%</span>
      </div>
      <p {...stylex.props(previewStyles.text7)} title={window.reset}>
        {window.reset}
      </p>
    </div>
  );
}

function ProviderQuotaCard({ provider }: { provider: QuotaProviderCopy }) {
  const Icon = provider.name === 'Claude' ? AnthropicIcon : OpenAIIcon;
  return (
    <div {...stylex.props(previewStyles.section2)}>
      <div {...stylex.props(previewStyles.row4)}>
        <Icon aria-hidden="true" {...stylex.props(previewStyles.text3)} />
        <span>{provider.name}</span>
      </div>
      <div {...stylex.props(previewStyles.grid)}>
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
    <div {...stylex.props(previewStyles.section3)}>
      <PreviewFrame label={copy.caption}>
        <div {...stylex.props(previewStyles.section4)}>
          <p {...stylex.props(previewStyles.text8)}>{copy.machines}</p>
        </div>

        <div {...stylex.props(previewStyles.section5)}>
          <p {...stylex.props(previewStyles.text9)}>{copy.myMachines}</p>
          <div {...stylex.props(previewStyles.stack)}>
            <div {...stylex.props(previewStyles.section6)}>
              <MachineIdentity name={copy.machineName} meta={copy.machineMeta} editable />
            </div>
            <div {...stylex.props(previewStyles.grid2)}>
              <ProviderQuotaCard provider={copy.claude} />
              <ProviderQuotaCard provider={copy.codex} />
            </div>
          </div>
        </div>

        <div {...stylex.props(previewStyles.section7)}>
          <p {...stylex.props(previewStyles.text9)}>{copy.otherMachines}</p>
          <div {...stylex.props(previewStyles.section8)}>
            <MachineIdentity
              name={copy.otherMachineName}
              meta={`${copy.otherMachineMeta} · ${copy.owner}`}
            />
          </div>
        </div>
      </PreviewFrame>
      <p {...stylex.props(previewStyles.text10)}>{copy.caption}</p>
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
    <div {...stylex.props(previewStyles.row5)}>
      {(['day', 'week', 'month', 'total'] as const).map((range) => (
        <span
          key={range}
          {...stylex.props(
            previewStyles.rangeTab,
            range === 'total' ? previewStyles.rangeSelected : previewStyles.rangeIdle
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
    <div {...stylex.props(previewStyles.section9)}>
      <p {...stylex.props(previewStyles.text11)}>{label}</p>
      <p {...stylex.props(previewStyles.text12)}>{value}</p>
      <Icon aria-hidden="true" {...stylex.props(previewStyles.overlay2)} />
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
      {...stylex.props(previewStyles.frame3)}
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
    <div {...stylex.props(previewStyles.section3)}>
      <PreviewFrame label={copy.caption}>
        <div {...stylex.props(previewStyles.row6)}>
          <div {...stylex.props(previewStyles.section)}>
            <p {...stylex.props(previewStyles.text2)}>{copy.workspace}</p>
          </div>
          <UsageRangeTabs copy={copy} />
        </div>

        <div {...stylex.props(previewStyles.grid3)}>
          <UsageKpiCard
            icon="tokens"
            label={copy.tokens}
            value={formatCompact(USAGE_TOTAL_TOKENS, locale)}
          />
          <UsageKpiCard icon="cost" label={copy.cost} value={formatUsd(USAGE_TOTAL_COST, locale)} />
        </div>

        <div {...stylex.props(previewStyles.section10)}>
          <p {...stylex.props(previewStyles.text8)}>{copy.byModel}</p>
          <div {...stylex.props(previewStyles.section8)}>
            <UsageStackedAreaChart locale={locale} />
          </div>
          <div {...stylex.props(previewStyles.row7)}>
            {modelTotals.map((model) => (
              <span key={model.id} {...stylex.props(previewStyles.row8)}>
                <span
                  aria-hidden="true"
                  {...stylex.props(previewStyles.frame4)}
                  style={{ backgroundColor: model.color }}
                />
                <span {...stylex.props(previewStyles.text13)}>{model.label}</span>
                <span {...stylex.props(previewStyles.text14)}>{model.formattedTotal}</span>
              </span>
            ))}
          </div>
        </div>
      </PreviewFrame>
      <p {...stylex.props(previewStyles.text10)}>{copy.caption}</p>
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
    <div {...stylex.props(previewStyles.text15)}>
      <div {...stylex.props(previewStyles.row9)}>
        <p {...stylex.props(previewStyles.text16)}>{copy.title}</p>
        <X aria-hidden="true" {...stylex.props(previewStyles.text17)} />
      </div>
      <div {...stylex.props(previewStyles.row10)}>
        <Bell aria-hidden="true" {...stylex.props(previewStyles.text18)} />
        <span {...stylex.props(previewStyles.text19)}>{copy.prompt}</span>
      </div>
      <div {...stylex.props(previewStyles.row11)}>
        <span {...stylex.props(previewStyles.text20)}>{copy.block}</span>
        <span {...stylex.props(previewStyles.text21)}>{copy.allow}</span>
      </div>
    </div>
  );
}

function MobileNotificationPreview({ locale }: { locale: ReplicaLocale }) {
  const copy = NOTIFICATION_COPY[locale].mobile;
  return (
    <div {...stylex.props(previewStyles.row12)}>
      <img
        src="/_docs-assets/logo-96.png"
        alt=""
        width={44}
        height={44}
        {...stylex.props(previewStyles.frame5)}
      />
      <div {...stylex.props(previewStyles.section11)}>
        <div {...stylex.props(previewStyles.row13)}>
          <p {...stylex.props(previewStyles.text22)}>{copy.title}</p>
          <span {...stylex.props(previewStyles.text23)}>{copy.now}</span>
        </div>
        <p {...stylex.props(previewStyles.text24)}>{copy.app}</p>
        <p {...stylex.props(previewStyles.text25)}>{copy.body}</p>
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
    <div {...stylex.props(previewStyles.section3)}>
      <PreviewFrame label={copy.caption}>
        <div {...stylex.props(previewStyles.section12)}>
          {variant === 'browser' ? (
            <BrowserNotificationPreview locale={locale} />
          ) : (
            <MobileNotificationPreview locale={locale} />
          )}
        </div>
      </PreviewFrame>
      <p {...stylex.props(previewStyles.text10)}>{copy.caption}</p>
    </div>
  );
}

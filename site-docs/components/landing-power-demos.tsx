'use client';

/**
 * Live product demos for the landing "More power" section, rendered by the
 * display-only replicas in `landing-replica/` (Usage settings view + embedded PR
 * tab) with deterministic mock data — no static screenshots, no app imports.
 *
 * Usage legends use agent glyphs (by model) and initials avatars (by member)
 * instead of bare color swatches.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import { LANDING_AGENTS } from './landing-agents.generated';
import { Sparkles } from 'lucide-react';
import {
  buildLandingUsageDay,
  buildLandingUsageDemo,
  LANDING_PR_DEMO_DATA,
  LANDING_USAGE_MEMBERS,
} from './landing-power-demo-data';
import { POWER_DEMO_COPY, type PowerDemoCopy } from './landing-power-i18n';
import { AnthropicIcon, OpenAIIcon } from './landing-replica/icons';
import { PowerPrView } from './landing-replica/power-pr';
import {
  PowerUsageView,
  type StackedAreaSeries,
  type UsageRange,
} from './landing-replica/power-usage';

const MARK_BY_ID = new Map(LANDING_AGENTS.map((agent) => [agent.id, agent]));

const MEMBER_INITIALS: ReadonlyMap<string, string> = new Map(
  LANDING_USAGE_MEMBERS.map((member) => [member.id, member.initials])
);

/** Map model id / label → landing agent mark id for glyph lookup. */
function agentMarkIdForSeries(seriesId: string): string | null {
  const key = seriesId.toLowerCase();
  if (key.includes('claude') || key.includes('fable') || key.includes('opus')) {
    return 'claude-code';
  }
  if (key.includes('gpt') || key.includes('codex') || key.includes('o1') || key.includes('o3')) {
    return 'codex';
  }
  if (key.includes('gemini')) return 'gemini';
  if (key.includes('grok')) return 'grok';
  if (key.includes('kimi')) return 'kimi';
  if (key.includes('deepseek')) return 'deepseek';
  if (MARK_BY_ID.has(seriesId)) return seriesId;
  return null;
}

const USAGE_RANGE_ROTATION = ['week', 'month', 'total', 'day'] as const;
const USAGE_RANGE_ROTATION_MS = 1_500;

function PowerDemoShell({
  children,
  sceneRef,
  pageScroll = false,
  manualScroll = false,
}: {
  children: ReactNode;
  sceneRef?: Ref<HTMLDivElement>;
  pageScroll?: boolean;
  manualScroll?: boolean;
}) {
  return (
    <div
      ref={sceneRef}
      className={`uw-power__demo${manualScroll ? ' uw-power__demo--manual-scroll' : ''} lody-app-preview dark text-foreground`}
      data-power-scroll-scene={pageScroll ? '' : undefined}
      aria-hidden={manualScroll ? undefined : true}
      inert={manualScroll ? undefined : true}
    >
      <div className="uw-power__demo-inner">{children}</div>
    </div>
  );
}

/** Neutral agent glyph — series color is carried by the tinted label text. */
function renderModelSeriesMarker(series: StackedAreaSeries) {
  const markId = agentMarkIdForSeries(series.id);
  const mark = markId ? MARK_BY_ID.get(markId) : undefined;
  return (
    <span
      className="uw-usage-marker uw-usage-marker--agent"
      title={series.label}
      aria-hidden="true"
    >
      {mark ? (
        <span
          className="uw-usage-marker__glyph"
          // Registry marks are trusted build-time assets.
          dangerouslySetInnerHTML={{ __html: mark.svg }}
        />
      ) : (
        <span className="uw-usage-marker__fallback" />
      )}
    </span>
  );
}

const MODEL_ICON_CLASS = 'h-3 w-3 shrink-0 text-foreground/50';

/** Monochrome provider mark for a day-breakdown model row (app `ModelBrandIcon`). */
function renderModelIcon(modelId: string) {
  const id = modelId.toLowerCase().split(/[:/]/).pop() ?? '';
  if (/^(claude|anthropic)/.test(id)) return <AnthropicIcon className={MODEL_ICON_CLASS} />;
  if (/^(gpt|codex|o[1-9]|chatgpt|openai)/.test(id)) {
    return <OpenAIIcon className={MODEL_ICON_CLASS} />;
  }
  const markId = agentMarkIdForSeries(id);
  const mark = markId ? MARK_BY_ID.get(markId) : undefined;
  if (!mark) return <Sparkles className={MODEL_ICON_CLASS} />;
  return (
    <span
      className="h-3 w-3 shrink-0 text-foreground/50 inline-flex items-center justify-center [&_svg]:h-full [&_svg]:w-full"
      // Registry marks are trusted build-time assets.
      dangerouslySetInnerHTML={{ __html: mark.svg }}
    />
  );
}

/** Neutral initials avatar — series color is on the label text. */
function renderMemberSeriesMarker(series: StackedAreaSeries) {
  const initials = MEMBER_INITIALS.get(series.id) ?? series.label.slice(0, 1).toUpperCase();
  return (
    <span
      className="uw-usage-marker uw-usage-marker--member"
      title={series.label}
      aria-hidden="true"
    >
      <span className="uw-usage-marker__avatar">{initials}</span>
    </span>
  );
}

function PowerUsageDemo({ copy }: { copy: PowerDemoCopy }) {
  const sceneRef = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState<UsageRange>('week');
  const [selectedUsageDay, setSelectedUsageDay] = useState<number | null>(null);
  const data = useMemo(() => buildLandingUsageDemo(range, copy), [range, copy]);
  const usageDay = useMemo(
    () => (selectedUsageDay === null ? undefined : buildLandingUsageDay(selectedUsageDay)),
    [selectedUsageDay]
  );
  const dayOpen = selectedUsageDay !== null;

  // Rotate ranges only while the frame is visible and motion is allowed, so the
  // number/chart transitions never become permanent background work. An open day
  // breakdown also holds the rotation: an hourly range switch would close it.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || dayOpen) return undefined;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let visible = false;
    let interval: number | undefined;

    const stop = () => {
      if (interval === undefined) return;
      window.clearInterval(interval);
      interval = undefined;
    };
    const sync = () => {
      if (!visible || document.hidden || reducedMotion.matches) {
        stop();
        return;
      }
      if (interval !== undefined) return;
      interval = window.setInterval(() => {
        setRange((current) => {
          const index = USAGE_RANGE_ROTATION.indexOf(current);
          return USAGE_RANGE_ROTATION[(index + 1) % USAGE_RANGE_ROTATION.length] ?? 'week';
        });
      }, USAGE_RANGE_ROTATION_MS);
    };

    const observer = new IntersectionObserver(
      ([entry]) => {
        visible = Boolean(entry?.isIntersecting);
        sync();
      },
      { threshold: 0.4 }
    );
    observer.observe(scene);
    document.addEventListener('visibilitychange', sync);
    reducedMotion.addEventListener('change', sync);

    return () => {
      stop();
      observer.disconnect();
      document.removeEventListener('visibilitychange', sync);
      reducedMotion.removeEventListener('change', sync);
    };
  }, [dayOpen]);

  return (
    <PowerDemoShell sceneRef={sceneRef} manualScroll>
      <PowerUsageView
        labels={copy.usage}
        intlLocale={copy.intlLocale}
        workspaceName="Lody"
        range={range}
        onRangeChange={setRange}
        totals={data.totals}
        byModelBuckets={data.byModelBuckets}
        byMemberBuckets={data.byMemberBuckets}
        calendar={data.calendar}
        timeline={data.timeline}
        renderModelSeriesMarker={renderModelSeriesMarker}
        renderMemberSeriesMarker={renderMemberSeriesMarker}
        tintModelSeriesLabel
        tintMemberSeriesLabel
        costFractionDigits={0}
        usageDay={usageDay}
        onSelectedUsageDayChange={setSelectedUsageDay}
        renderModelIcon={renderModelIcon}
      />
    </PowerDemoShell>
  );
}

function PowerPrDemo({ copy }: { copy: PowerDemoCopy }) {
  return (
    <PowerDemoShell pageScroll>
      <PowerPrView data={LANDING_PR_DEMO_DATA} labels={copy.pr} intlLocale={copy.intlLocale} />
    </PowerDemoShell>
  );
}

export type PowerDemoId = 'usage' | 'pr';

export function LandingPowerDemo({ id, locale }: { id: PowerDemoId; locale: 'en' | 'zh' }) {
  const copy = POWER_DEMO_COPY[locale];
  return id === 'usage' ? <PowerUsageDemo copy={copy} /> : <PowerPrDemo copy={copy} />;
}

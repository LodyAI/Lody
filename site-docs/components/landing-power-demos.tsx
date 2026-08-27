'use client';

/**
 * Live product-component demos for the landing "More power" section.
 * Uses pure views (StatsSettingsView, PrTabView) + deterministic mock data so
 * chrome tokens match the landing dark theme — no static screenshots.
 *
 * Usage legends use agent glyphs (by model/agent series) and avatar rings
 * (by member) instead of bare color swatches.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createInstance } from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { StatsSettingsView } from '@/components/settings/stats-setting-pure';
import type { SettingsUsageRange } from '@/components/settings/settings-data-cache';
import type { StackedAreaSeriesDef } from '@/components/settings/usage-stacked-area-chart';
import { PrTabView } from '@/components/sessions/pr-tab-view';
import { TooltipProvider } from '@/ui/tooltip';
import { LANDING_AGENTS } from './landing-agents.generated';
import {
  buildLandingUsageDay,
  buildLandingUsageDemo,
  LANDING_PR_DEMO_DATA,
  LANDING_PR_DEMO_NUMBER,
  LANDING_PR_DEMO_REPO,
  LANDING_USAGE_MEMBERS,
} from './landing-power-demo-data';
import { POWER_DEMO_I18N } from './landing-power-i18n';

const powerI18n = createInstance();

void powerI18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  defaultNS: 'translation',
  ns: ['translation'],
  resources: {
    en: { translation: POWER_DEMO_I18N.en },
    zh_CN: { translation: POWER_DEMO_I18N.zh_CN },
  },
  keySeparator: false,
  interpolation: { escapeValue: false },
  initImmediate: false,
  react: { useSuspense: false },
});

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
  children: React.ReactNode;
  sceneRef?: React.Ref<HTMLDivElement>;
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

/**
 * Neutral agent glyph — series color is carried by the label text
 * (`tintSeriesLabel`), not a colored ring.
 */
function AgentSeriesMarker({ series }: { series: StackedAreaSeriesDef }) {
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

/** Neutral initials avatar — series color is on the label text. */
function MemberSeriesMarker({ series }: { series: StackedAreaSeriesDef }) {
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

function PowerUsageDemo() {
  const sceneRef = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState<SettingsUsageRange>('week');
  const [selectedUsageDay, setSelectedUsageDay] = useState<number | null>(null);
  const data = useMemo(() => buildLandingUsageDemo(range), [range]);
  const usageDay = useMemo(
    () => (selectedUsageDay === null ? undefined : buildLandingUsageDay(selectedUsageDay)),
    [selectedUsageDay]
  );

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return undefined;

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
  }, []);

  const renderModelSeriesMarker = useCallback(
    (series: StackedAreaSeriesDef) => <AgentSeriesMarker series={series} />,
    []
  );
  const renderMemberSeriesMarker = useCallback(
    (series: StackedAreaSeriesDef) => <MemberSeriesMarker series={series} />,
    []
  );

  return (
    <PowerDemoShell sceneRef={sceneRef} manualScroll>
      <StatsSettingsView
        workspaceName="Lody"
        range={range}
        onRangeChange={setRange}
        ready
        totals={data.totals}
        byModelBuckets={data.byModelBuckets}
        byMemberBuckets={data.byMemberBuckets}
        usageCalendar={data.usageCalendar}
        usageTimeline={data.usageTimeline}
        usageDay={usageDay}
        usageDayLoading={false}
        onSelectedUsageDayChange={setSelectedUsageDay}
        workspaceId="landing-ws"
        loading={false}
        renderModelSeriesMarker={renderModelSeriesMarker}
        renderMemberSeriesMarker={renderMemberSeriesMarker}
        tintModelSeriesLabel
        tintMemberSeriesLabel
        costFractionDigits={0}
      />
    </PowerDemoShell>
  );
}

function PowerPrDemo() {
  return (
    <PowerDemoShell pageScroll>
      <TooltipProvider delayDuration={200}>
        <PrTabView
          repoFullName={LANDING_PR_DEMO_REPO}
          prNumber={LANDING_PR_DEMO_NUMBER}
          state="ready"
          data={LANDING_PR_DEMO_DATA}
          mergeMethod="squash"
          branchExists
          embedded
          onPostComment={async () => {
            /* decorative */
          }}
          onSelectMergeMethod={() => {
            /* decorative */
          }}
          onMerge={async () => {
            /* decorative */
          }}
          onSetState={async () => {
            /* decorative */
          }}
        />
      </TooltipProvider>
    </PowerDemoShell>
  );
}

export type PowerDemoId = 'usage' | 'pr';

export function LandingPowerDemo({ id, locale }: { id: PowerDemoId; locale: 'en' | 'zh' }) {
  const lng = locale === 'zh' ? 'zh_CN' : 'en';
  if (powerI18n.language !== lng) {
    void powerI18n.changeLanguage(lng);
  }

  return (
    <I18nextProvider i18n={powerI18n}>
      {id === 'usage' ? <PowerUsageDemo /> : <PowerPrDemo />}
    </I18nextProvider>
  );
}

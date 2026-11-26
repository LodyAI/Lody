'use client';

/**
 * LandingFeatureTabs
 *
 * Editorial feature indicator above the surfaced app preview — bare labels, no
 * segmented-control chrome. The ACTIVE tab keeps a hairline progress rail that
 * fills left→right over its duration and, on completion, auto-advances to the
 * next tab (looping). Clicking a tab jumps to it and restarts its fill.
 *
 * Controlled: the parent owns `active` so it can drive the app preview's scripted
 * scenario for the current tab. Per-tab durations let scripted tabs (e.g. the
 * worktree demo) run longer than static ones. Styling lives in
 * `app/underwater.css` (`.underwater-tabs*`) and follows the deep-ocean palette.
 */

import { useEffect, useRef, useState } from 'react';
import type { LandingLocale } from './landing';

export const DEFAULT_TAB_DURATION_MS = 6000;

type FeatureTab = { title: string };

const TABLIST_LABEL: Record<LandingLocale, string> = {
  en: 'Lody highlights',
  zh: 'Lody 核心亮点',
  'zh-hant': 'Lody 核心亮點',
  ja: 'Lody の主な機能',
  ko: 'Lody 주요 기능',
  es: 'Aspectos destacados de Lody',
  fr: 'Points forts de Lody',
  ru: 'Ключевые возможности Lody',
};

const TABS: Record<LandingLocale, FeatureTab[]> = {
  en: [
    { title: 'Parallel worktrees' },
    { title: 'Live diff review' },
    { title: 'Design mode' },
    { title: 'Mobile access' },
  ],
  zh: [
    { title: 'Worktree 并行开发' },
    { title: '实时差异查看' },
    { title: '设计模式' },
    { title: '移动端访问' },
  ],
  'zh-hant': [
    { title: 'Worktree 並行開發' },
    { title: '即時差異檢視' },
    { title: '設計模式' },
    { title: '行動裝置存取' },
  ],
  ja: [
    { title: '並列 Worktree' },
    { title: 'リアルタイム差分レビュー' },
    { title: 'デザインモード' },
    { title: 'モバイルアクセス' },
  ],
  ko: [
    { title: '병렬 Worktree' },
    { title: '실시간 Diff 리뷰' },
    { title: '디자인 모드' },
    { title: '모바일 접근' },
  ],
  es: [
    { title: 'Worktrees en paralelo' },
    { title: 'Revisión de diffs en vivo' },
    { title: 'Modo diseño' },
    { title: 'Acceso móvil' },
  ],
  fr: [
    { title: 'Worktrees en parallèle' },
    { title: 'Revue de diff en direct' },
    { title: 'Mode design' },
    { title: 'Accès mobile' },
  ],
  ru: [
    { title: 'Параллельные worktree' },
    { title: 'Просмотр diff в реальном времени' },
    { title: 'Режим дизайна' },
    { title: 'Мобильный доступ' },
  ],
};

export function LandingFeatureTabs({
  locale,
  active,
  onActiveChange,
  durations,
  paused = false,
}: {
  locale: LandingLocale;
  active: number;
  onActiveChange: (index: number) => void;
  /** Per-tab fill duration in ms; falls back to DEFAULT_TAB_DURATION_MS. */
  durations?: readonly number[];
  /**
   * Freeze the active fill without unmounting it. Unmounting (old behavior)
   * restarted the carousel — and every ghost demo — whenever the stage
   * re-entered view after a scroll. Use CSS `animation-play-state` instead.
   */
  paused?: boolean;
}) {
  const tabs = TABS[locale];
  // Bumped whenever the active tab changes so the fill element remounts and its
  // CSS animation restarts from 0 (both on auto-advance and manual click).
  const [runKey, setRunKey] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);
  // Mirror paused in a ref so onAnimationEnd (stale closure) can ignore fires
  // that land while we're frozen.
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    setReducedMotion(window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }, []);

  useEffect(() => {
    setRunKey((key) => key + 1);
  }, [active]);

  const goTo = (index: number) => {
    if (pausedRef.current) return;
    onActiveChange(((index % tabs.length) + tabs.length) % tabs.length);
  };

  return (
    <div className="underwater-tabs" role="tablist" aria-label={TABLIST_LABEL[locale]}>
      {tabs.map((tab, index) => {
        const isActive = index === active;
        const duration = durations?.[index] ?? DEFAULT_TAB_DURATION_MS;
        return (
          <button
            key={tab.title}
            type="button"
            role="tab"
            aria-selected={isActive}
            className={['underwater-tabs__tab', isActive ? 'is-active' : '']
              .filter(Boolean)
              .join(' ')}
            onClick={() => {
              // Manual click always allowed (clears pause intent for that hop).
              onActiveChange(((index % tabs.length) + tabs.length) % tabs.length);
            }}
          >
            <span className="underwater-tabs__label">{tab.title}</span>
            <span className="underwater-tabs__track" aria-hidden="true">
              {isActive ? (
                reducedMotion ? (
                  <span className="underwater-tabs__fill is-static" />
                ) : (
                  <span
                    key={runKey}
                    className="underwater-tabs__fill"
                    style={{
                      animationDuration: `${duration}ms`,
                      animationPlayState: paused ? 'paused' : 'running',
                    }}
                    onAnimationEnd={() => {
                      if (!pausedRef.current) goTo(active + 1);
                    }}
                  />
                )
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export default LandingFeatureTabs;

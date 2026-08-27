'use client';

/**
 * UnderwaterExperience
 *
 * Landing first act as ordinary document flow + a light hero snap:
 *   - Hero copy (desktop full first screen for the Scroll hint).
 *   - A small downward scroll on the hero spring-scrolls to the product stage.
 *   - Product stage (tabs + `LandingAppPreview`) is an in-flow section —
 *     free scroll after that (no wheel-lock tabs, no rest pin).
 *   - Post-demo marketing stack continues below.
 *   - WebGL point cloud is `position: fixed` with a static camera.
 *   - Demos unlock once (first time the stage is reached / in view) and then
 *     keep running independent of scroll — never pause/null on leave, so
 *     scrolling past the stage does not restart ghost scripts.
 */

import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import {
  DESIGN_DEMO_DURATION_MS,
  DIFF_DEMO_DURATION_MS,
  MOBILE_DEMO_DURATION_MS,
  WORKTREE_DEMO_DURATION_MS,
} from './landing-demo-durations';
import { LandingFeatureTabs } from './landing-feature-tabs';
import { LandingCtaSection, type LandingCtaCopy } from './landing-cta-section';
import {
  LandingMobileDeepSection,
  type MobileDeepSectionCopy,
} from './landing-mobile-deep-section';
import { LandingCliSection, type CliSectionCopy } from './landing-cli-section';
import {
  LandingOrchestrationSection,
  type OrchestrationSectionCopy,
} from './landing-orchestration-section';
import { LandingPowerSection, type PowerSectionCopy } from './landing-power-section';
import {
  LandingSubscriptionsSection,
  type SubscriptionsSectionCopy,
} from './landing-subscriptions-section';
import type { LandingLocale } from './landing';
import { LandingHeroDownload } from './landing-hero-download';
import { RotatingWords } from './landing-interactions';
import type { PlatformDownloadLabels } from './landing-platform-download';

// The point-cloud background (and with it all of three.js) stays out of the
// landing's critical chunk: the hero copy hydrates without parsing three, while
// this module-eval import() starts fetching the chunk in parallel. Until it
// mounts, the container's CSS gradient (kept in sync with the BG shader) shows.
const underwaterBackgroundModule = import('./underwater-background');
const UnderwaterPointCloudBackground = lazy(() => underwaterBackgroundModule);

// The product stage sits below the 100dvh hero, but `landing-app-preview` is the
// landing's single heaviest module: it mounts REAL product UI and drags the chat
// composer, markdown renderer and katex in behind it. Statically imported it
// landed in the landing's critical chunk and delayed the hero's LCP for UI the
// visitor cannot even see yet. Lazy + armed on approach instead.
//
// Unlike three.js above, this one is NOT module-eval — the fetch is deferred to
// `armPreview()` so the hero copy and the WebGL scene get the first-paint
// bandwidth to themselves. Arming is deliberately EARLY (a viewport of
// rootMargin, plus an idle fallback for visitors who never scroll), so by the
// time the stage is reached the chunk is parsed and the frame is never empty.
const LandingAppPreview = lazy(() =>
  import('./landing-app-preview').then((m) => ({ default: m.LandingAppPreview }))
);

/** Preview chunk is armed at most once per page session. */
const PREVIEW_ARM_ROOT_MARGIN = '100% 0px';
/** Fallback for visitors who never scroll — still warm, just not on the hot path. */
const PREVIEW_ARM_IDLE_TIMEOUT_MS = 2_500;

const TAB_DURATIONS: readonly number[] = [
  WORKTREE_DEMO_DURATION_MS,
  DIFF_DEMO_DURATION_MS,
  DESIGN_DEMO_DURATION_MS,
  MOBILE_DEMO_DURATION_MS,
];

/**
 * Light downward nudge on the hero before springing to the product stage.
 * One mouse-wheel notch / short trackpad flick is enough.
 */
const HERO_SPRING_THRESHOLD_PX = 20;
/**
 * Touch / free-scroll: once past this Y while still on the hero, spring to the
 * product stage (momentum rarely "settles" on iOS).
 */
const HERO_TOUCH_SPRING_PX = 14;
/** Backup settle pause (ms) for fine-pointer free-scroll that leaked past wheel. */
const HERO_SETTLE_SPRING_MS = 48;
/**
 * After a spring lands (or the user reaches the stage), never re-snap until
 * they return near the top of the page. Prevents re-yanking while reading demos.
 */
const HERO_REARM_BELOW_PX = 24;

export type HeroCopy = {
  eyebrow: string;
  prefix: string;
  words: string[];
  suffix: string;
  lead: string;
  secondary: string;
  secondaryHref: string;
  webAppHref: string;
  labels: PlatformDownloadLabels;
  otherDownloads: string;
  otherDownloadsHref: string;
};

function wheelDeltaYPx(event: WheelEvent): number {
  if (event.deltaMode === 1) return event.deltaY * 16;
  if (event.deltaMode === 2) return event.deltaY * (window.innerHeight || 800);
  return event.deltaY;
}

/** Smooth ease-out — no overshoot (overshoot felt like a yank-back at the end). */
function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

/** Document Y of an element's top edge (offsetTop alone is offsetParent-relative). */
function documentTop(el: HTMLElement): number {
  return el.getBoundingClientRect().top + window.scrollY;
}

export function UnderwaterExperience({
  locale,
  hero,
  subscriptions,
  orchestration,
  cli,
  power,
  mobileDeep,
  cta,
}: {
  locale: LandingLocale;
  hero: HeroCopy;
  subscriptions: SubscriptionsSectionCopy;
  orchestration: OrchestrationSectionCopy;
  cli: CliSectionCopy;
  power: PowerSectionCopy;
  mobileDeep: MobileDeepSectionCopy;
  cta: LandingCtaCopy;
}) {
  /** Always 0 — background camera no longer tracks a scroll dive. */
  const diveRef = useRef(0);
  const stageRef = useRef<HTMLElement | null>(null);
  const [featureTab, setFeatureTab] = useState(0);
  /**
   * One-shot latch: demos start the first time the stage is reached / seen,
   * then the `demo` prop stays non-null for the rest of the page session.
   * Never null it on scroll — that tore down ghost scripts and replayed them.
   */
  const [demosLive, setDemosLive] = useState(false);
  const demosLiveRef = useRef(false);
  /**
   * Soft freeze only: when the stage is mostly off-screen, pause the tab fill
   * (no auto-advance) without unmounting demos. Unrelated to unlock.
   */
  const [stageInView, setStageInView] = useState(true);
  /**
   * One-shot latch for the lazy preview chunk. Separate from `demosLive`: the
   * preview must already be MOUNTED by the time demos unlock, otherwise the
   * stage would show an empty frame at exactly the moment the visitor arrives.
   */
  const [previewArmed, setPreviewArmed] = useState(false);
  const previewArmedRef = useRef(false);
  const armPreview = () => {
    if (previewArmedRef.current) return;
    previewArmedRef.current = true;
    setPreviewArmed(true);
  };
  const unlockDemos = () => {
    // Reaching the stage always implies the preview is needed now.
    armPreview();
    if (demosLiveRef.current) return;
    demosLiveRef.current = true;
    setDemosLive(true);
  };

  useEffect(() => {
    const root = document.documentElement;
    root.classList.add('underwater-landing-page');
    return () => {
      root.classList.remove('underwater-landing-page');
    };
  }, []);

  // Unlock once on first intersect. `stageInView` gates ghost pointer work +
  // tab auto-advance only — never nulls `demo` (that would remount scripts).
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      unlockDemos();
      setStageInView(true);
      return undefined;
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        const ratio = entry?.intersectionRatio ?? 0;
        // Unlock once the stage is meaningfully on screen.
        if (ratio >= 0.2) unlockDemos();
        // Ghost clicks/drags only while the stage is mostly visible. At ~half
        // off-screen, stop pointer theater so it cannot yank the viewport back.
        setStageInView(ratio >= 0.55);
      },
      { threshold: [0, 0.15, 0.2, 0.35, 0.55, 0.75, 1] }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Arm the lazy preview chunk one viewport ahead of the stage, so scrolling down
  // never lands on an unmounted frame. Idle timer is the no-scroll fallback.
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      armPreview();
      return undefined;
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) armPreview();
      },
      { rootMargin: PREVIEW_ARM_ROOT_MARGIN }
    );
    io.observe(el);

    const hasIdle = typeof window.requestIdleCallback === 'function';
    const idle = hasIdle
      ? window.requestIdleCallback(armPreview, { timeout: PREVIEW_ARM_IDLE_TIMEOUT_MS })
      : window.setTimeout(armPreview, PREVIEW_ARM_IDLE_TIMEOUT_MS);

    return () => {
      io.disconnect();
      if (hasIdle) window.cancelIdleCallback(idle as number);
      else window.clearTimeout(idle as number);
    };
  }, []);

  // Hero → product stage: desktop (fine pointer) light-nudge springs to the demo.
  // Touch / mobile: free document scroll only — no auto-snap to the stage.
  useEffect(() => {
    let springRaf = 0;
    let settleTimer = 0;
    let springing = false;
    /** Once true, never re-snap until the user returns near y=0. */
    let stageReached = false;
    let wheelAcc = 0;
    let finePointer = window.matchMedia('(pointer: fine)').matches;
    const finePointerMq = window.matchMedia('(pointer: fine)');
    const onPointerTypeChange = () => {
      finePointer = finePointerMq.matches;
      wheelAcc = 0;
      // Touch devices never spring; clear any in-flight settle.
      if (!finePointer) {
        window.clearTimeout(settleTimer);
        settleTimer = 0;
      }
    };
    finePointerMq.addEventListener('change', onPointerTypeChange);

    const stageTop = () => {
      const el = stageRef.current;
      if (!el) return window.innerHeight || 0;
      return documentTop(el);
    };

    const cancelSpring = () => {
      if (springRaf) window.cancelAnimationFrame(springRaf);
      springRaf = 0;
      springing = false;
    };

    const markStageReached = () => {
      stageReached = true;
      wheelAcc = 0;
      // Start demos when we land on the stage — not when IO later flickers.
      unlockDemos();
    };

    const springToStage = () => {
      // Touch / coarse pointer: never auto-snap — free document scroll only.
      if (!finePointer) return;
      if (stageReached || springing) return;
      cancelSpring();
      const dest = Math.max(0, stageTop());
      const startY = window.scrollY;
      // Already at/past the stage — arm free scroll, don't yank.
      if (startY >= dest - 4) {
        markStageReached();
        return;
      }
      const delta = dest - startY;
      if (Math.abs(delta) < 1.5) {
        window.scrollTo(0, dest);
        markStageReached();
        return;
      }

      springing = true;
      wheelAcc = 0;
      const start = performance.now();
      const duration = Math.min(420, Math.max(220, Math.abs(delta) * 0.4));

      const frame = (now: number) => {
        const t = Math.min(1, (now - start) / duration);
        // Clamp to dest — never overshoot past the stage top.
        const y = Math.min(dest, startY + delta * easeOutCubic(t));
        window.scrollTo(0, Math.max(0, y));
        if (t < 1) {
          springRaf = window.requestAnimationFrame(frame);
          return;
        }
        springRaf = 0;
        springing = false;
        window.scrollTo(0, dest);
        markStageReached();
      };
      springRaf = window.requestAnimationFrame(frame);
    };

    /** Still above the product stage (with a small slop). */
    const onHero = (scrollY: number) => scrollY < stageTop() - 8;

    const onWheel = (event: WheelEvent) => {
      if (!finePointer) return;
      if (event.defaultPrevented) return;
      if (springing) {
        event.preventDefault();
        return;
      }
      // After the first snap, never intercept again until re-armed at the top.
      if (stageReached) return;

      const dy = wheelDeltaYPx(event);
      if (dy === 0) return;

      // Only hijack while on the hero going down — stage+ is free scroll.
      if (dy > 0 && onHero(window.scrollY)) {
        event.preventDefault();
        wheelAcc += dy;
        if (wheelAcc >= HERO_SPRING_THRESHOLD_PX) {
          wheelAcc = 0;
          springToStage();
        }
      } else {
        wheelAcc = 0;
      }
    };

    const onScroll = () => {
      const y = window.scrollY;

      // Re-arm the hero snap only when the user is back near the page top.
      if (y <= HERO_REARM_BELOW_PX) {
        stageReached = false;
      }
      // If they've scrolled onto/past the stage without spring, free-scroll mode.
      if (!stageReached && !springing && y >= stageTop() - 4) {
        markStageReached();
      }

      if (springing) return;

      // Touch: no auto-spring. Fine pointer: settle fallback if wheel leaked.
      if (!finePointer || stageReached) return;
      if (!onHero(y) || y < HERO_TOUCH_SPRING_PX) return;

      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => {
        if (!finePointer || springing || stageReached) return;
        const yy = window.scrollY;
        if (yy >= HERO_TOUCH_SPRING_PX && onHero(yy)) springToStage();
      }, HERO_SETTLE_SPRING_MS);
    };

    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      finePointerMq.removeEventListener('change', onPointerTypeChange);
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('scroll', onScroll);
      cancelSpring();
      window.clearTimeout(settleTimer);
    };
  }, []);

  const activeDemo = !demosLive
    ? null
    : featureTab === 0
      ? 'worktree'
      : featureTab === 1
        ? 'diff'
        : featureTab === 2
          ? 'design'
          : featureTab === 3
            ? 'mobile'
            : null;

  return (
    <>
      <Suspense
        fallback={
          <div className="underwater-bg underwater-landing__bg" aria-hidden="true">
            <div className="underwater-bg__overlay" />
          </div>
        }
      >
        <UnderwaterPointCloudBackground className="underwater-landing__bg" diveRef={diveRef} />
      </Suspense>

      <main id="main-content" className="underwater-main">
        <div className="underwater-hero">
          <div className="underwater-hero__inner">
            <p className="underwater-hero__eyebrow">{hero.eyebrow}</p>

            <h1 className="underwater-hero__title">
              {hero.words.length === 0 ? (
                <>
                  {hero.prefix}
                  {hero.suffix ? (
                    <>
                      <br />
                      {hero.suffix}
                    </>
                  ) : null}
                </>
              ) : (
                <RotatingWords
                  intervalMs={2200}
                  prefix={hero.prefix}
                  suffix={hero.suffix}
                  words={hero.words}
                />
              )}
            </h1>

            <p className="underwater-hero__lead">{hero.lead}</p>

            <LandingHeroDownload
              copy={{
                secondary: hero.secondary,
                secondaryHref: hero.secondaryHref,
                webAppHref: hero.webAppHref,
                labels: hero.labels,
                otherDownloads: hero.otherDownloads,
                otherDownloadsHref: hero.otherDownloadsHref,
              }}
            />
          </div>

          <div className="underwater-hero__scroll-hint" aria-hidden="true">
            <span className="underwater-hero__scroll-label">
              {locale === 'zh' ? '向下滚动' : 'Scroll'}
            </span>
            <span className="underwater-hero__scroll-icon">
              <span className="underwater-hero__scroll-chevron" />
            </span>
          </div>
        </div>

        <div className="uw-content">
          <div className="uw-middle-door">
            {/* In-flow product stage — free scroll; nested UI is display-only. */}
            <section
              ref={stageRef}
              className="underwater-reveal"
              data-active={demosLive ? 'true' : 'false'}
              aria-label={locale === 'zh' ? '产品演示' : 'Product demo'}
            >
              <div className="underwater-reveal__glow" aria-hidden="true" />
              <div className="underwater-reveal__stack">
                <LandingFeatureTabs
                  locale={locale}
                  active={featureTab}
                  onActiveChange={setFeatureTab}
                  durations={TAB_DURATIONS}
                  // Soft freeze off-screen (CSS play-state). Never unmount demos.
                  paused={!demosLive || !stageInView}
                />
                {/* The preview is a DISPLAY-ONLY replica of the product: the frame is
                    already `pointer-events: none`, so none of the real buttons and
                    session rows inside it can be clicked. Without `inert` they were
                    still in the accessibility tree and the tab order — a screen
                    reader announced dozens of unusable controls (and Lighthouse
                    flagged them: unnamed button, label/name mismatch, target size).
                    `inert` removes the whole subtree from AT and focus; `aria-hidden`
                    keeps older engines in line. Both belong here on the frame, NOT on
                    the labelled <section>, whose name still describes the stage. */}
                <div className="underwater-reveal__frame" data-settled="true" aria-hidden inert>
                  {/* `demo` stays set once unlocked — scroll must not remount scripts.
                      `ghostEnabled` only silences pointer theater off-stage.
                      `previewArmed` only gates the FIRST mount; it never flips back,
                      so this cannot remount ghost scripts mid-scroll. */}
                  {previewArmed ? (
                    <Suspense fallback={null}>
                      <LandingAppPreview
                        locale={locale}
                        demo={activeDemo}
                        ghostEnabled={demosLive && stageInView}
                      />
                    </Suspense>
                  ) : null}
                </div>
              </div>
            </section>

            <div className="uw-post-demo">
              <LandingSubscriptionsSection copy={subscriptions} />
              <LandingOrchestrationSection copy={orchestration} />
              <LandingCliSection copy={cli} />
              <LandingPowerSection copy={power} locale={locale} />
              <LandingMobileDeepSection copy={mobileDeep} />
            </div>
          </div>
          <LandingCtaSection copy={cta} />
        </div>
      </main>
    </>
  );
}

export default UnderwaterExperience;

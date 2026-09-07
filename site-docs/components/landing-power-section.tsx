'use client';

/**
 * Landing post-demo — team collaboration surfaces that already ship:
 * usage by member + in-session PR/CI/merge demos, plus short team points
 * (shared sessions, private machines). Diff review stays in the play stage.
 */

import { useEffect, useRef, useState } from 'react';
import { LandingPowerDemo, type PowerDemoId } from './landing-power-demos';

export type PowerSectionCopy = {
  /** Optional category label, e.g. Team. */
  eyebrow?: string;
  title: string;
  body: string;
  /**
   * Compact team beats that don't need a product demo (e.g. shared sessions).
   * Rendered as a short list under the header — no pills / media.
   */
  points?: readonly string[];
  docsLink?: { href: string; label: string };
  features: readonly {
    id: PowerDemoId;
    title: string;
    /** Optional; omit or empty when the demo already carries the story. */
    body?: string;
  }[];
};

/**
 * Product demos pull packages/components (NumberFlow, Radix, …) that peer React
 * 18 in the monorepo. Mount only after hydration so SSR never dual-loads React.
 */
function ClientPowerDemo({
  id,
  locale,
  title,
  summary,
}: {
  id: PowerDemoId;
  locale: 'en' | 'zh';
  title: string;
  /** SSR-visible summary so crawlers still get the feature without hydrate. */
  summary?: string;
}) {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  if (!ready) {
    return (
      <div
        className="uw-power__demo uw-power__demo--ssr lody-app-preview dark"
        data-power-scroll-scene={id === 'pr' ? '' : undefined}
        aria-hidden
        inert
      >
        <p className="uw-power__demo-ssr-title">{title}</p>
        {summary ? <p className="uw-power__demo-ssr-body">{summary}</p> : null}
      </div>
    );
  }
  return <LandingPowerDemo id={id} locale={locale} />;
}

export function LandingPowerSection({
  copy,
  locale,
}: {
  copy: PowerSectionCopy;
  locale: 'en' | 'zh';
}) {
  const sectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return undefined;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;

    const update = () => {
      frame = 0;
      const viewportHeight = window.innerHeight;
      const scenes = section.querySelectorAll<HTMLElement>('[data-power-scroll-scene]');

      scenes.forEach((scene, index) => {
        const scrollports = scene.querySelectorAll<HTMLElement>(
          '.uw-power__demo-inner, [data-pr-content-scroll-area] [data-radix-scroll-area-viewport]'
        );
        if (scrollports.length === 0) return;

        const rect = scene.getBoundingClientRect();
        // Start once half of the frame has entered, then finish while
        // its bottom edge is still visible. Smoothstep keeps both ends calm
        // instead of making the content track the wheel 1:1.
        const startTop = viewportHeight - rect.height * 0.5;
        const endTop = viewportHeight * 0.18 - rect.height;
        const rawProgress = (startTop - rect.top) / Math.max(1, startTop - endTop);
        const stagger = index * 0.07;
        const linearProgress = reducedMotion.matches
          ? 0
          : Math.min(1, Math.max(0, (rawProgress - stagger) / (1 - stagger)));
        const progress = linearProgress * linearProgress * (3 - 2 * linearProgress);

        scrollports.forEach((scrollport) => {
          const maxScroll = Math.max(0, scrollport.scrollHeight - scrollport.clientHeight);
          scrollport.scrollTop = maxScroll * progress;
        });
      });
    };

    const requestUpdate = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(update);
    };

    const resizeObserver = new ResizeObserver(requestUpdate);
    resizeObserver.observe(section);
    const mutationObserver = new MutationObserver(requestUpdate);
    mutationObserver.observe(section, { childList: true, subtree: true });

    window.addEventListener('scroll', requestUpdate, { passive: true });
    window.addEventListener('resize', requestUpdate, { passive: true });
    reducedMotion.addEventListener('change', requestUpdate);
    requestUpdate();

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener('scroll', requestUpdate);
      window.removeEventListener('resize', requestUpdate);
      reducedMotion.removeEventListener('change', requestUpdate);
    };
  }, []);

  return (
    <section ref={sectionRef} className="uw-power" aria-labelledby="uw-power-title">
      <div className="uw-power__inner">
        <header className="uw-power__header">
          {copy.eyebrow ? <p className="uw-power__eyebrow">{copy.eyebrow}</p> : null}
          <h2 className="uw-power__title" id="uw-power-title">
            {copy.title}
          </h2>
          <p className="uw-power__body">{copy.body}</p>
          {copy.docsLink ? (
            <p className="uw-section-docs">
              <a href={copy.docsLink.href}>{copy.docsLink.label}</a>
            </p>
          ) : null}
          {copy.points && copy.points.length > 0 ? (
            <ul className="uw-power__points">
              {copy.points.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
          ) : null}
        </header>

        <div className="uw-power__grid">
          {copy.features.map((feature) => (
            <article key={feature.id} className="uw-power__card">
              <ClientPowerDemo
                id={feature.id}
                locale={locale}
                title={feature.title}
                summary={feature.body}
              />
              <h3 className="uw-power__card-title">{feature.title}</h3>
              {feature.body ? <p className="uw-power__card-body">{feature.body}</p> : null}
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

export default LandingPowerSection;

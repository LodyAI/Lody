'use client';

import { scheduleAfterLoadIdle } from '@site/lib/after-first-paint';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type TransitionEvent,
} from 'react';

export function LandingEffects() {
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add('lody-landing');

    const cleanupScrollReveal = installLandingScrollRevealEffect();
    const cleanupHeroPause = installHeroAnimationPauseEffect();

    return () => {
      cleanupScrollReveal();
      cleanupHeroPause();
      root.classList.remove('lody-landing');
    };
  }, []);

  return null;
}

export function CopyCommand(props: { command: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current !== undefined) window.clearTimeout(resetTimerRef.current);
    };
  }, []);

  async function copy() {
    if (!props.command) return;

    try {
      await navigator.clipboard.writeText(props.command);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = props.command;
      textarea.setAttribute('readonly', 'true');
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      textarea.style.top = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }

    setCopied(true);
    if (resetTimerRef.current !== undefined) window.clearTimeout(resetTimerRef.current);
    resetTimerRef.current = window.setTimeout(() => setCopied(false), 5000);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    void copy();
  }

  return (
    <div
      aria-label={copied ? `Copied: ${props.command}` : `Copy command: ${props.command}`}
      className={['alpha-pill alpha-pill--command', props.className].filter(Boolean).join(' ')}
      data-copied={copied ? 'true' : 'false'}
      onClick={() => void copy()}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
      title={copied ? 'Copied' : 'Click to copy'}
    >
      <span aria-hidden="true" className="alpha-pill__prompt">
        $
      </span>
      <code className="alpha-pill__cmd">{props.command}</code>
      <span aria-hidden="true" className="alpha-pill__sep" />
      <span aria-hidden="true" className="alpha-pill__copy">
        {copied ? (
          <svg className="alpha-pill__copy-icon" fill="none" viewBox="0 0 24 24">
            <path
              d="M20 6L9 17l-5-5"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="1.8"
            />
          </svg>
        ) : (
          <svg className="alpha-pill__copy-icon" fill="none" viewBox="0 0 24 24">
            <path
              d="M9 9V6.8C9 5.81 9.81 5 10.8 5H18.2C19.19 5 20 5.81 20 6.8V14.2C20 15.19 19.19 16 18.2 16H16"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="1.6"
            />
            <path
              d="M6.8 9H14.2C15.19 9 16 9.81 16 10.8V18.2C16 19.19 15.19 20 14.2 20H6.8C5.81 20 5 19.19 5 18.2V10.8C5 9.81 5.81 9 6.8 9Z"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="1.6"
            />
          </svg>
        )}
      </span>
    </div>
  );
}

export function RotatingWords(props: {
  prefix?: string;
  words: readonly string[];
  suffix?: string;
  intervalMs?: number;
  align?: 'auto' | 'start' | 'end' | 'center';
}) {
  const { prefix = '', words, suffix = '', intervalMs = 2000, align = 'auto' } = props;
  const [index, setIndex] = useState(0);
  const [transitionDisabled, setTransitionDisabled] = useState(false);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const [motionArmed, setMotionArmed] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);
  const wordRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const [widths, setWidths] = useState<number[]>([]);
  const [animateWidth, setAnimateWidth] = useState(false);

  const renderedWords = useMemo(() => {
    const first = words[0];
    if (words.length <= 1 || !first) return words;
    return [...words, first];
  }, [words]);

  useEffect(() => {
    return scheduleAfterLoadIdle(() => setMotionArmed(true));
  }, []);

  useEffect(() => {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    setPrefersReducedMotion(reducedMotion);
    if (!motionArmed || reducedMotion || words.length <= 1) return undefined;

    const stopTimer = () => {
      if (timerRef.current !== undefined) window.clearInterval(timerRef.current);
      timerRef.current = undefined;
    };

    const startTimer = () => {
      if (timerRef.current !== undefined) return;
      timerRef.current = window.setInterval(() => {
        setIndex((current) => current + 1);
      }, intervalMs);
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        stopTimer();
        return;
      }

      startTimer();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange, { passive: true });
    handleVisibilityChange();

    return () => {
      stopTimer();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [intervalMs, motionArmed, words.length]);

  // Measure each word's natural width so the viewport can size to the CURRENT
  // word instead of the widest one. The suffix then slides in to sit against it
  // (animated) rather than leaving a gap after short words. Wait until after
  // first paint so the H1 LCP box does not resize during the LCP window.
  useEffect(() => {
    if (!motionArmed) return undefined;
    const measure = () => {
      const next = wordRefs.current.map((el) => (el ? el.getBoundingClientRect().width : 0));
      setWidths((prev) =>
        prev.length === next.length && prev.every((v, i) => Math.abs(v - next[i]) < 0.5)
          ? prev
          : next
      );
    };
    measure();
    const raf = requestAnimationFrame(() => setAnimateWidth(true));
    let cancelled = false;
    void document.fonts.ready.then(() => {
      if (!cancelled) measure();
    });
    window.addEventListener('resize', measure, { passive: true });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', measure);
    };
  }, [motionArmed, renderedWords]);

  function disableTransitionBriefly() {
    setTransitionDisabled(true);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setTransitionDisabled(false));
    });
  }

  function handleTransitionEnd(event: TransitionEvent<HTMLSpanElement>) {
    if (event.propertyName !== 'transform' || words.length <= 1) return;
    if (index !== words.length) return;

    setIndex(0);
    disableTransitionBriefly();
  }

  useEffect(() => {
    if (words.length <= 1 || index <= words.length) return;
    setIndex(0);
    disableTransitionBriefly();
  }, [index, words.length]);

  const wordAlign = align === 'auto' ? getAutoAlign(prefix, suffix) : align;
  const renderedPrefix = needsSpaceAfterEnglishPrefix(prefix) ? `${prefix}\u00A0` : prefix;
  const srPrefix = needsSpaceAfterEnglishPrefix(prefix) ? `${prefix} ` : prefix;
  const srText = `${srPrefix}${words.join(' / ')}${suffix}`;
  const rootStyle = { '--rw-index': String(index) } as CSSProperties;
  const currentWidth = widths[index];
  const viewportStyle: CSSProperties | undefined =
    currentWidth != null
      ? {
          width: `${currentWidth}px`,
          transition: animateWidth ? 'width 360ms cubic-bezier(0.2, 0.9, 0.2, 1)' : 'none',
        }
      : undefined;

  return (
    <span className={`rw rw-align-${wordAlign}`} style={rootStyle}>
      <span className="sr-only">{srText}</span>
      <span aria-hidden="true" className="rw-prefix">
        {renderedPrefix}
      </span>
      <span aria-hidden="true" className="rw-viewport" style={viewportStyle}>
        <span
          className={[
            'rw-strip',
            prefersReducedMotion ? 'rw-strip-static' : '',
            transitionDisabled ? 'rw-strip-no-transition' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          onTransitionEnd={handleTransitionEnd}
        >
          {renderedWords.map((word, wordIndex) => (
            <span className="rw-item" key={`${wordIndex}-${word}`}>
              <span
                className="rw-word"
                ref={(el) => {
                  wordRefs.current[wordIndex] = el;
                }}
              >
                {word}
              </span>
            </span>
          ))}
        </span>
      </span>
      <span aria-hidden="true" className="rw-suffix">
        {suffix}
      </span>
    </span>
  );
}

function installHeroAnimationPauseEffect() {
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (prefersReducedMotion.matches) return () => undefined;

  const heroSection = document.querySelector<HTMLElement>('.landing .band.hero');
  if (!heroSection) return () => undefined;

  let rafId = 0;
  let lastOutOfView = false;

  const updateScrollState = () => {
    rafId = 0;
    const outOfView = heroSection.getBoundingClientRect().bottom < 0;

    if (outOfView !== lastOutOfView) {
      lastOutOfView = outOfView;
      document.documentElement.classList.toggle('lody-hero-out-of-view', outOfView);
    }
  };

  const requestScrollUpdate = () => {
    if (rafId) return;
    rafId = window.requestAnimationFrame(updateScrollState);
  };

  const handleVisibilityChange = () => {
    document.documentElement.classList.toggle('lody-page-hidden', document.hidden);
  };

  window.addEventListener('scroll', requestScrollUpdate, { passive: true });
  document.addEventListener('visibilitychange', handleVisibilityChange, { passive: true });

  requestScrollUpdate();
  handleVisibilityChange();

  return () => {
    window.removeEventListener('scroll', requestScrollUpdate);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    if (rafId) window.cancelAnimationFrame(rafId);
    document.documentElement.classList.remove('lody-hero-out-of-view', 'lody-page-hidden');
  };
}

function installLandingScrollRevealEffect() {
  const targets = Array.from(document.querySelectorAll<HTMLElement>('.landing .scroll-reveal'));
  if (targets.length === 0) return () => undefined;

  document.documentElement.classList.add('lody-scroll-reveal');
  for (const target of targets) target.classList.remove('is-inview');

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (prefersReducedMotion.matches) {
    for (const target of targets) target.classList.add('is-inview');
    return () => {
      document.documentElement.classList.remove('lody-scroll-reveal');
    };
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const target = entry.target;
        if (!(target instanceof HTMLElement)) continue;

        const isVisibleEnough = entry.isIntersecting && entry.intersectionRatio >= 0.25;
        const isGoneEnough = !entry.isIntersecting || entry.intersectionRatio <= 0.1;

        window.requestAnimationFrame(() => {
          if (isVisibleEnough) {
            target.classList.add('is-inview');
            return;
          }

          if (isGoneEnough) target.classList.remove('is-inview');
        });
      }
    },
    {
      rootMargin: '0px 0px -10% 0px',
      threshold: [0, 0.1, 0.25],
    }
  );

  const rafId = window.requestAnimationFrame(() => {
    for (const target of targets) observer.observe(target);
  });

  return () => {
    window.cancelAnimationFrame(rafId);
    observer.disconnect();
    document.documentElement.classList.remove('lody-scroll-reveal');
  };
}

function getAutoAlign(prefix: string, suffix: string): 'start' | 'end' | 'center' {
  if (prefix && !suffix) return 'start';
  if (!prefix && suffix) return 'end';
  return 'start';
}

function needsSpaceAfterEnglishPrefix(prefix: string) {
  if (!prefix) return false;
  if (/[\s\u00A0]$/.test(prefix)) return false;
  return /[A-Za-z0-9]$/.test(prefix);
}

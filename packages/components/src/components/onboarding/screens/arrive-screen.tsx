import { useCallback, useEffect, useState, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import queueCurrent from '@/assets/onboarding/intro/queue-current.png';
import quietWork from '@/assets/onboarding/intro/quiet-work.png';
import continuousScroll from '@/assets/onboarding/intro/continuous-scroll.png';
import readyToBegin from '@/assets/onboarding/intro/ready-to-begin.png';
import { WINDOW_DRAG_EXEMPT_CLASS } from '@/ui/window-drag-region';
import type { AudioLayers, OnboardingAudio } from '../ceremony/use-onboarding-audio';
import { playCut, playReveal, unlockSound } from '../ceremony/ui-sounds';
import {
  ARRIVE_BEAT_MS,
  EASE_OUT,
  copyEnterProps,
  useOnboardingReducedMotion,
} from '../motion-tokens';
import { flatSurface } from '../shared/flat-surface.stylex';

type ArriveBeat = {
  art: string;
  titleKey: string;
  titleFallback: string;
  descriptionKey: string;
  descriptionFallback: string;
  score: { energy: number; layers: Partial<AudioLayers>; cue?: 'cut' | 'reveal' };
  tiltDeg: number;
  offsetX: number;
  offsetY: number;
};

export const ARRIVE_BEATS: readonly ArriveBeat[] = [
  {
    art: queueCurrent,
    titleKey: 'onboarding.intro.problem',
    titleFallback: 'Stay in the flow.',
    descriptionKey: 'onboarding.intro.problem.description',
    descriptionFallback: 'Lody takes over, so the work keeps moving.',
    score: { energy: 0.22, layers: { pad: 1, arp: 0.08, bass: 0.2 } },
    tiltDeg: -2.2,
    offsetX: -6,
    offsetY: 4,
  },
  {
    art: quietWork,
    titleKey: 'onboarding.intro.turn',
    titleFallback: 'Step away with confidence.',
    descriptionKey: 'onboarding.intro.turn.description',
    descriptionFallback: 'Handle other things while the work keeps moving.',
    score: { energy: 0.5, layers: { pad: 0.95, arp: 0.48, bass: 0.52 }, cue: 'cut' },
    tiltDeg: 1.8,
    offsetX: 6,
    offsetY: -2,
  },
  {
    art: continuousScroll,
    titleKey: 'onboarding.intro.multiDevice',
    titleFallback: 'Pick up anytime.',
    descriptionKey: 'onboarding.intro.multiDevice.description',
    descriptionFallback:
      'Continue seamlessly across devices and remotely control progress while you are out.',
    score: { energy: 0.72, layers: { pad: 1, arp: 0.78, bass: 0.7 }, cue: 'cut' },
    tiltDeg: -1.1,
    offsetX: 0,
    offsetY: 2,
  },
] as const;

export const ACCOUNT_BEAT_ART = readyToBegin;

const styles = stylex.create({
  stage: {
    width: '100%',
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    paddingInline: 'clamp(1.75rem, 5vw, 4.5rem)',
    paddingBlock: 'clamp(3rem, 6vh, 4.5rem)',
    position: 'relative',
  },
  splitRow: {
    width: '100%',
    maxWidth: '58rem',
    display: 'flex',
    flexDirection: {
      default: 'column-reverse',
      '@media (min-width: 860px)': 'row',
    },
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 'clamp(2rem, 5vw, 4.5rem)',
  },
  leftColumn: {
    width: '100%',
    maxWidth: '25.5rem',
    minHeight: {
      default: 'auto',
      '@media (min-width: 860px)': '16rem',
    },
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
  },
  arriveCopy: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.875rem',
    cursor: 'pointer',
    userSelect: 'none',
  },
  arriveTitle: {
    margin: 0,
    fontSize: 'clamp(2rem, 3.6vw, 2.85rem)',
    fontWeight: 620,
    letterSpacing: '-0.032em',
    lineHeight: 1.12,
    color: 'var(--flat-ink)',
  },
  arriveDescription: {
    margin: 0,
    fontSize: '1.03125rem',
    lineHeight: 1.55,
    color: 'var(--flat-ink-secondary)',
    maxWidth: '23rem',
  },
  beatDots: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.375rem',
    marginTop: '0.5rem',
  },
  beatDot: {
    width: '6px',
    height: '6px',
    borderRadius: '999px',
    backgroundColor: 'var(--flat-fill-strong)',
    transitionProperty: 'width, background-color',
    transitionDuration: '200ms',
  },
  beatDotActive: {
    width: '18px',
    backgroundColor: 'var(--flat-ink)',
  },
  artDeck: {
    position: 'relative',
    width: 'min(clamp(220px, 34vw, 356px), 78vw)',
    aspectRatio: '0.77',
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    userSelect: 'none',
  },
  artCard: {
    position: 'absolute',
    inset: 0,
    borderRadius: '14px',
    overflow: 'hidden',
    backgroundColor: '#FFFFFF',
    padding: '8px',
    boxShadow: '0 20px 44px -18px rgba(20, 20, 19, 0.16), 0 2px 6px rgba(20, 20, 19, 0.04)',
  },
  artImg: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    borderRadius: '8px',
    display: 'block',
    pointerEvents: 'none',
  },
  skipCorner: {
    position: 'fixed',
    insetInlineEnd: 'clamp(1.5rem, 4vw, 3rem)',
    bottom: 'clamp(1.25rem, 3.5vh, 2.25rem)',
    zIndex: 25,
  },
  skipBtn: {
    appearance: 'none',
    borderWidth: 0,
    borderRadius: '999px',
    backgroundColor: 'transparent',
    color: 'var(--flat-ink-tertiary)',
    fontSize: '0.8125rem',
    fontWeight: 500,
    paddingBlock: '0.4375rem',
    paddingInline: '0.75rem',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.375rem',
    cursor: 'pointer',
    transitionProperty: 'color, background-color, transform',
    transitionDuration: '140ms, 140ms, 80ms',
    ':hover': {
      color: 'var(--flat-ink)',
      backgroundColor: 'var(--flat-fill)',
    },
    ':active': {
      transform: 'scale(0.98)',
    },
    ':focus-visible': {
      outline: '2px solid var(--flat-ink)',
      outlineOffset: '2px',
    },
  },
});

/**
 * Continuous split stage shared by `Arrive` (beats 1–3) and `Account` (beat 4 `ready-to-begin`).
 *
 * On `Arrive`, beats 1–3 auto-advance every 2.4s, pause on mouse hover, advance
 * on click or key press, and offer a subtle bottom-right `跳过 ⏎`. When advancing
 * into `Account`, `ready-to-begin` lands on the right-hand stack and stays still
 * while the left column swaps in-place to the sign-in / workspace controls (§5.1 & §5.2).
 */
export function ContinuousEditorialStage({
  mode,
  audio,
  onFinishArrive,
  accountContent,
}: {
  mode: 'arrive' | 'account';
  audio: Pick<OnboardingAudio, 'start' | 'setEnergy' | 'setLayers'>;
  onFinishArrive: () => void;
  accountContent?: ReactNode;
}) {
  const { t } = useTranslation();
  const reducedMotion = useOnboardingReducedMotion();
  const [beatIndex, setBeatIndex] = useState(0);
  const [hovered, setHovered] = useState(false);

  const { start: startAudio, setEnergy, setLayers } = audio;

  useEffect(() => {
    if (mode !== 'arrive') return undefined;
    startAudio();
    const unlock = () => {
      unlockSound();
      startAudio();
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, [mode, startAudio]);

  useEffect(() => {
    if (mode === 'account') {
      setEnergy(0.56);
      setLayers({ pad: 1, arp: 0.44, bass: 0.58 });
      return;
    }
    const beat = ARRIVE_BEATS[beatIndex] ?? ARRIVE_BEATS[0]!;
    setEnergy(beat.score.energy);
    setLayers(beat.score.layers);
  }, [beatIndex, mode, setEnergy, setLayers]);

  const stepForward = useCallback(() => {
    if (mode !== 'arrive') return;
    if (beatIndex < ARRIVE_BEATS.length - 1) {
      playCut();
      setBeatIndex((prev) => prev + 1);
    } else {
      playReveal();
      onFinishArrive();
    }
  }, [beatIndex, mode, onFinishArrive]);

  // Auto-advance beats 1–3 every 2.4s unless hovered or reduced-motion (§5.1, §6.3).
  useEffect(() => {
    if (mode !== 'arrive' || hovered || reducedMotion) return undefined;
    const timer = window.setTimeout(() => {
      stepForward();
    }, ARRIVE_BEAT_MS);
    return () => window.clearTimeout(timer);
  }, [beatIndex, hovered, mode, reducedMotion, stepForward]);

  // Fast-forward on any key press during `Arrive`; `Enter` on `跳过` jumps straight to beat 4.
  useEffect(() => {
    if (mode !== 'arrive') return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.key === 'Tab') return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onFinishArrive();
        return;
      }
      if (event.key === 'Enter' && (event.target as HTMLElement | null)?.dataset.arriveSkip === 'true') {
        return;
      }
      event.preventDefault();
      stepForward();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mode, onFinishArrive, stepForward]);

  const currentBeat = ARRIVE_BEATS[beatIndex] ?? ARRIVE_BEATS[0]!;
  const visibleCards =
    mode === 'account'
      ? [
          ...ARRIVE_BEATS.map((b, idx) => ({
            key: `arrive-${idx}`,
            src: b.art,
            tilt: b.tiltDeg,
            x: b.offsetX,
            y: b.offsetY,
          })),
          {
            key: 'account-ready',
            src: ACCOUNT_BEAT_ART,
            tilt: 0.9,
            x: 2,
            y: 0,
          },
        ]
      : ARRIVE_BEATS.slice(0, beatIndex + 1).map((b, idx) => ({
          key: `arrive-${idx}`,
          src: b.art,
          tilt: b.tiltDeg,
          x: b.offsetX,
          y: b.offsetY,
        }));

  return (
    <div
      {...stylex.props(styles.stage, flatSurface.onboardingLightScope)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={(event) => {
        if (mode !== 'arrive') return;
        const target = event.target as HTMLElement | null;
        if (target?.closest('button, a, input')) return;
        stepForward();
      }}
      data-testid={mode === 'arrive' ? 'onboarding-arrive-stage' : 'onboarding-account-stage'}
    >
      <div {...stylex.props(styles.splitRow)}>
        {/* Left column: copy swaps in-place between Arrive beats and Account controls */}
        <div {...stylex.props(styles.leftColumn)} className={WINDOW_DRAG_EXEMPT_CLASS}>
          <AnimatePresence mode="wait" initial={false}>
            {mode === 'arrive' ? (
              <motion.div
                key={`arrive-copy-${beatIndex}`}
                {...copyEnterProps(reducedMotion)}
                {...stylex.props(styles.arriveCopy)}
              >
                <h1 {...stylex.props(styles.arriveTitle)}>
                  {t(currentBeat.titleKey, { defaultValue: currentBeat.titleFallback })}
                </h1>
                <p {...stylex.props(styles.arriveDescription)}>
                  {t(currentBeat.descriptionKey, {
                    defaultValue: currentBeat.descriptionFallback,
                  })}
                </p>
                <div {...stylex.props(styles.beatDots)} aria-hidden="true">
                  {ARRIVE_BEATS.map((_, idx) => (
                    <span
                      key={idx}
                      {...stylex.props(
                        styles.beatDot,
                        idx === beatIndex && styles.beatDotActive
                      )}
                    />
                  ))}
                </div>
              </motion.div>
            ) : (
              <motion.div key="account-copy" {...copyEnterProps(reducedMotion)}>
                {accountContent}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Right column: continuous editorial illustration stack */}
        <div {...stylex.props(styles.artDeck)} aria-hidden="true">
          {visibleCards.map((card) => (
            <motion.div
              key={card.key}
              initial={
                reducedMotion
                  ? { opacity: 0 }
                  : { opacity: 0, y: card.y - 14, x: card.x, rotate: card.tilt * 1.4, scale: 1.015 }
              }
              animate={
                reducedMotion
                  ? { opacity: 1 }
                  : { opacity: 1, y: card.y, x: card.x, rotate: card.tilt, scale: 1 }
              }
              transition={{ duration: reducedMotion ? 0.16 : 0.42, ease: EASE_OUT }}
              {...stylex.props(styles.artCard)}
            >
              <img src={card.src} alt="" {...stylex.props(styles.artImg)} />
            </motion.div>
          ))}
        </div>
      </div>

      {mode === 'arrive' ? (
        <div {...stylex.props(styles.skipCorner)} className={WINDOW_DRAG_EXEMPT_CLASS}>
          <button
            type="button"
            data-arrive-skip="true"
            data-testid="onboarding-arrive-skip"
            onClick={(event) => {
              event.stopPropagation();
              playReveal();
              onFinishArrive();
            }}
            {...stylex.props(styles.skipBtn)}
          >
            <span>{t('onboarding.arrive.skip', { defaultValue: 'Skip' })}</span>
            <span aria-hidden="true">⏎</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

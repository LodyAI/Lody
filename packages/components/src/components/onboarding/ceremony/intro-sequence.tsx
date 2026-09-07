import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import queueCurrent from '@/assets/onboarding/intro/queue-current.png';
import quietWork from '@/assets/onboarding/intro/quiet-work.png';
import continuousScroll from '@/assets/onboarding/intro/continuous-scroll.png';
import readyToBegin from '@/assets/onboarding/intro/ready-to-begin.png';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { WINDOW_DRAG_EXEMPT_CLASS } from '@/ui/window-drag-region';
import type { AudioLayers } from './use-onboarding-audio';
import { playClick, playCut, playReveal, playSelect } from './ui-sounds';

// The ceremony is ONE composition, not two half-screens: a block of words and
// a small pile of polaroids standing shoulder to shoulder, centred together on
// the stage. The stage is width-bounded, so the distance the eye travels
// between the sentence and the picture is a design decision instead of a
// function of the user's monitor — a full-bleed `grid-cols-2` parks the two
// masses ~700px apart on a wide display and every beat costs a saccade across
// dead space. Here they stay one glance apart at any window size.
//
// Everything that can shift is pinned: the copy lives in a fixed-height slot
// (so a two-line beat and a five-line beat don't move the button or the pile's
// vertical centre), and every card is exactly the same size (so the pile reads
// as one stable object instead of breathing with each illustration's ratio).

type IntroBeat = {
  /** The final beat waits for the user to start setup. */
  hold: number;
  art: string;
  titleKey: string;
  titleFallback: string;
  descriptionKey?: string;
  descriptionFallback?: string;
  score: { energy: number; layers: Partial<AudioLayers>; cue?: 'cut' | 'reveal' };
  final?: boolean;
};

const INTRO_BEATS: IntroBeat[] = [
  {
    hold: 2,
    art: queueCurrent,
    titleKey: 'onboarding.intro.problem',
    titleFallback: 'Stay in the flow.',
    descriptionKey: 'onboarding.intro.problem.description',
    descriptionFallback: 'Lody takes over, so the work keeps moving.',
    score: { energy: 0.22, layers: { pad: 1, arp: 0.08, bass: 0.2 } },
  },
  {
    hold: 3,
    art: quietWork,
    titleKey: 'onboarding.intro.turn',
    titleFallback: 'Step away with confidence.',
    descriptionKey: 'onboarding.intro.turn.description',
    descriptionFallback: 'Handle other things while the work keeps moving.',
    score: { energy: 0.5, layers: { pad: 0.95, arp: 0.48, bass: 0.52 }, cue: 'cut' },
  },
  {
    hold: 3,
    art: continuousScroll,
    titleKey: 'onboarding.intro.multiDevice',
    titleFallback: 'Pick up anytime.',
    descriptionKey: 'onboarding.intro.multiDevice.description',
    descriptionFallback:
      'Continue seamlessly across devices and remotely control progress while you are out.',
    score: { energy: 0.72, layers: { pad: 1, arp: 0.78, bass: 0.7 }, cue: 'cut' },
  },
  {
    hold: Number.POSITIVE_INFINITY,
    art: readyToBegin,
    titleKey: 'onboarding.intro.invitation.title',
    titleFallback: 'Start exploring!',
    score: { energy: 0.56, layers: { pad: 1, arp: 0.44, bass: 0.58 }, cue: 'reveal' },
    final: true,
  },
];

const LAST = INTRO_BEATS.length - 1;

export const INTRO_SHOT_COUNT = INTRO_BEATS.length;

const CJK_CEREMONY_FONT = "'Hiragino Sans GB', 'Noto Sans CJK SC', 'Microsoft YaHei', sans-serif";

const INTRO_EASE = 'cubic-bezier(.22,1,.36,1)';

/**
 * Every measurement of the stage lives here, as custom properties, so the one
 * breakpoint in the ceremony is declared exactly once and the two knobs worth
 * touching (`--gutter`, `--card-h`) are next to each other.
 */
const INTRO_MOTION_CSS = `
.lody-intro-stage {
  /* The pile. Height leads, so the composition shrinks in short windows; the
     vw cap stops it crowding the words in narrow ones. */
  --card-h: min(clamp(280px, 54vh, 512px), 42vw);
  --card-w: calc(var(--card-h) * 0.77);
  /* A reading measure for the 58px headline (~13ch) — not "half the screen". */
  --copy-w: min(46vw, 410px);
  /* The eye-travel budget: the only thing between the two masses. */
  --gutter: clamp(24px, 2.8vw, 46px);
  /* Reserved height for the tallest beat so the button slot and the pile's
     vertical centre never move. Tracks both axes: the headline scales with vw
     while the stage scales with vh. */
  --copy-slot: max(220px, min(38vh, 360px), min(27vw, 360px));
}
.lody-intro-row { flex-direction: column-reverse; }
@media (min-width: 900px) {
  .lody-intro-row { flex-direction: row; }
}
@media (max-width: 899px) {
  .lody-intro-stage {
    --card-h: min(34vh, 300px);
    --copy-w: min(90vw, 480px);
    --gutter: clamp(18px, 3.4vh, 36px);
    --copy-slot: max(150px, min(26vh, 260px));
  }
}

/* A card is held slightly above its spot, tipped toward the viewer, then
   dropped onto the pile — the shadow travels with it, wide and faint while
   airborne, tight once it makes contact. */
@keyframes lody-intro-card-in {
  0% {
    opacity: 0;
    transform: translate(-50%, -50%) translate(var(--x), calc(var(--y) - 14px))
      rotate(var(--tilt-from)) scale(1.014);
    box-shadow: 0 24px 46px -18px rgba(15, 23, 42, .2), 0 2px 6px rgba(15, 23, 42, .03);
  }
  58% {
    opacity: 1;
  }
  100% {
    opacity: 1;
    transform: translate(-50%, -50%) translate(var(--x), var(--y)) rotate(var(--tilt)) scale(1);
    box-shadow: 0 1px 2px rgba(15, 23, 42, .05), 0 12px 28px -10px rgba(15, 23, 42, .16);
  }
}
@keyframes lody-intro-copy-in {
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes lody-intro-copy-out {
  from { opacity: 1; transform: translateY(0); }
  to { opacity: 0; transform: translateY(-8px); }
}
@media (prefers-reduced-motion: reduce) {
  .lody-intro-motion { animation: none !important; transition-duration: 0ms !important; }
}
`;

/**
 * Resting spot for each card, in percent of the card's own size. A card never
 * moves once it has landed — later cards simply cover it while its own corner
 * keeps peeking out. The offsets are deliberately tiny (±4%, ~15px): the pile
 * has to read as a single object standing next to the sentence so the two can
 * share one optical centre. `tape` shifts the masking-tape strip so four
 * stacked cards don't line their tape up into a stripe.
 */
const CARD_SPOTS: { x: number; y: number; tilt: number; tape: number }[] = [
  { x: -3.5, y: 2.5, tilt: -3.4, tape: -14 },
  { x: 3, y: -2, tilt: 2.6, tape: 10 },
  { x: -2, y: -3.5, tilt: -1.4, tape: -5 },
  { x: 2.5, y: 3, tilt: 2.2, tape: 16 },
];

const CARD_LANDED_SHADOW = '0 1px 2px rgba(15,23,42,.05), 0 12px 28px -10px rgba(15,23,42,.16)';

function PolaroidCard({
  beat,
  index,
  front,
}: {
  beat: IntroBeat;
  index: number;
  /** The most recently landed card; it casts the deepest shadow. */
  front: boolean;
}): React.JSX.Element {
  const spot = CARD_SPOTS[index % CARD_SPOTS.length]!;
  return (
    <figure
      aria-hidden={!front}
      className="lody-intro-motion absolute left-1/2 top-1/2 m-0 rounded-[8px] border border-slate-900/[0.06] bg-white  p-[clamp(9px,0.9vw,14px)] pb-[clamp(15px,1.7vw,26px)]"
      style={
        {
          '--tilt': `${spot.tilt}deg`,
          '--tilt-from': `${spot.tilt + 6}deg`,
          '--x': `${spot.x}%`,
          '--y': `${spot.y}%`,
          width: 'var(--card-w)',
          height: 'var(--card-h)',
          zIndex: index + 1,
          transform: `translate(-50%, -50%) translate(${spot.x}%, ${spot.y}%) rotate(${spot.tilt}deg)`,
          boxShadow: CARD_LANDED_SHADOW,
          animation: front ? `lody-intro-card-in 900ms ${INTRO_EASE} both` : 'none',
        } as React.CSSProperties
      }
    >
      <span
        className="absolute -top-2.5 left-1/2 h-6 w-[38%] rounded-[2px] bg-[#d9e8f2]/70 shadow-[0_1px_2px_rgba(15,23,42,.07)]"
        style={{ transform: `translateX(calc(-50% + ${spot.tape}px)) rotate(-3.5deg)` }}
        aria-hidden
      />
      {/* Fixed photo window: every illustration gets the same frame, so the
          pile never changes size between beats. `contain` keeps the artwork
          uncropped — switch to `object-cover` if the art is full-bleed. */}
      <span className="block h-full w-full overflow-hidden rounded-[3px] bg-[#fbfbfc]">
        <img
          src={beat.art}
          alt=""
          draggable={false}
          className="h-full w-full select-none object-contain"
        />
      </span>
    </figure>
  );
}

function PolaroidStack({ current }: { current: number }): React.JSX.Element {
  return (
    <div
      className="relative shrink-0"
      style={{ width: 'var(--card-w)', height: 'var(--card-h)' }}
      aria-hidden
    >
      {INTRO_BEATS.slice(0, current + 1).map((beat, index) => (
        <PolaroidCard key={beat.art} beat={beat} index={index} front={index === current} />
      ))}
    </div>
  );
}

/**
 * CJK copy reads better broken at its own punctuation. The trailing trim
 * matters: with `whitespace-pre-line`, a break after the final full stop leaves
 * a phantom empty line that silently adds a line of height to the headline.
 */
function breakAtPunctuation(value: string): string {
  return value.replace(/([，。！？；：,.!?;:])\s*/g, '$1\n').trimEnd();
}

function IntroCopy({
  chinese,
  title,
  description,
}: {
  chinese: boolean;
  title: string;
  description?: string;
}): React.JSX.Element {
  return (
    <>
      <h1
        className={cn(
          'whitespace-pre-line text-balance text-slate-950',
          chinese
            ? 'max-w-[11em] text-[clamp(38px,4vw,46px)] font-normal leading-[1.18] tracking-[-0.015em]'
            : 'max-w-[13ch] text-[clamp(40px,4.3vw,60px)] font-medium leading-[1.04] tracking-[-0.04em]'
        )}
        style={chinese ? { fontFamily: CJK_CEREMONY_FONT } : undefined}
      >
        {breakAtPunctuation(title)}
      </h1>
      {description ? (
        <p
          className={cn(
            'mt-5 max-w-[33ch] text-slate-600',
            chinese ? 'text-[19px] leading-[1.55] tracking-[0.01em]' : 'text-[16px] leading-relaxed'
          )}
          style={chinese ? { fontFamily: CJK_CEREMONY_FONT } : undefined}
        >
          {description}
        </p>
      ) : null}
    </>
  );
}

export function IntroSequence({
  playing,
  onStart,
  setEnergy,
  setLayers,
}: {
  playing: boolean;
  onStart: () => void;
  setEnergy: (value: number) => void;
  setLayers: (layers: Partial<AudioLayers>) => void;
}): React.JSX.Element {
  const [current, setCurrent] = useState(0);
  const handoffTimer = useRef<number | null>(null);
  const { t, i18n } = useTranslation();
  const chinese = (i18n.resolvedLanguage ?? i18n.language) === 'zh_CN';
  const [departing, setDeparting] = useState(false);

  // Remember the beat we came from so its sentence can fade out underneath the
  // incoming one — a remount on its own hard-cuts the old copy.
  const seenRef = useRef(current);
  const outgoingRef = useRef<number | null>(null);
  if (seenRef.current !== current) {
    outgoingRef.current = seenRef.current;
    seenRef.current = current;
  }

  useEffect(
    () => () => {
      if (handoffTimer.current !== null) window.clearTimeout(handoffTimer.current);
    },
    []
  );

  const beginSetup = useCallback(() => {
    playSelect();
    setDeparting(true);
    if (handoffTimer.current !== null) window.clearTimeout(handoffTimer.current);
    handoffTimer.current = window.setTimeout(onStart, 480);
  }, [onStart]);

  useEffect(() => {
    if (!playing || current >= LAST) return undefined;
    const timer = window.setTimeout(
      () => setCurrent((step) => step + 1),
      INTRO_BEATS[current]!.hold * 1000
    );
    return () => window.clearTimeout(timer);
  }, [current, playing]);

  useEffect(() => {
    if (!playing) return;
    const { energy, layers, cue } = INTRO_BEATS[current]!.score;
    setEnergy(energy);
    setLayers(layers);
    if (cue === 'cut') playCut();
    if (cue === 'reveal') playReveal();
  }, [current, playing, setEnergy, setLayers]);

  const beat = INTRO_BEATS[current]!;
  const copyFor = (index: number) => {
    const item = INTRO_BEATS[index]!;
    return {
      title: t(item.titleKey, item.titleFallback),
      description:
        item.descriptionKey && item.descriptionFallback
          ? t(item.descriptionKey, item.descriptionFallback)
          : undefined,
    };
  };
  const outgoing = outgoingRef.current;

  return (
    <div
      className="lody-intro-stage absolute inset-0 flex items-center justify-center px-[clamp(20px,4vw,56px)] py-[clamp(20px,4vh,48px)]"
      style={{
        opacity: departing ? 0 : 1,
        transform: departing ? 'scale(0.985)' : 'scale(1)',
        transformOrigin: 'center',
        transition: 'opacity 420ms ease, transform 520ms cubic-bezier(.22,1,.36,1)',
        pointerEvents: departing ? 'none' : 'auto',
      }}
    >
      <style>{INTRO_MOTION_CSS}</style>

      {/* Words and pile, adjacent and centred as one block. Nothing is pinned
          to the window edges, so the composition can never spread apart. */}
      <div className="lody-intro-row flex items-center justify-center gap-[var(--gutter)]">
        <div className="flex shrink-0 flex-col items-start" style={{ width: 'var(--copy-w)' }}>
          {/* Fixed slot, vertically centred: the sentence's optical centre
              stays locked to the pile's centre however many lines it runs to,
              and the button slot below never moves. */}
          <div className="relative w-full" style={{ height: 'var(--copy-slot)' }}>
            {outgoing !== null && outgoing !== current ? (
              <div
                key={`out-${outgoing}`}
                aria-hidden
                className="lody-intro-motion absolute inset-0 flex flex-col justify-center"
                style={{ animation: 'lody-intro-copy-out 320ms ease both' }}
              >
                <IntroCopy chinese={chinese} {...copyFor(outgoing)} />
              </div>
            ) : null}
            <div
              key={`in-${current}`}
              aria-live="polite"
              className="lody-intro-motion absolute inset-0 flex flex-col justify-center"
              style={{ animation: `lody-intro-copy-in 700ms ${INTRO_EASE} 130ms both` }}
            >
              <IntroCopy chinese={chinese} {...copyFor(current)} />
            </div>
          </div>

          {/* One control anchor, fixed height, on the headline's left rule:
              "skip" occupies it during the beats and the CTA takes it over at
              the end, so nothing jumps and nothing hides in a far corner. */}
          <div className="mt-[clamp(18px,2.6vh,32px)] flex h-11 items-center">
            {beat.final ? (
              <Button
                size="lg"
                disabled={departing}
                autoFocus
                className="lody-intro-motion rounded-md bg-slate-950 px-6 text-white hover:bg-slate-800"
                style={{ animation: `lody-intro-copy-in 520ms ${INTRO_EASE} 300ms both` }}
                onClick={beginSetup}
              >
                {t('onboarding.intro.cta', 'Configure Lody')}
              </Button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  playClick();
                  setCurrent(LAST);
                }}
                className={cn(
                  WINDOW_DRAG_EXEMPT_CLASS,
                  'absolute right-8 top-14 z-10 border-b border-transparent px-1 py-1 font-mono text-[10.5px] tracking-[0.08em] text-slate-600 transition-colors hover:border-slate-500 hover:text-slate-950'
                )}
              >
                {t('onboarding.intro.skip', 'Skip intro')}
              </button>
            )}
          </div>
        </div>

        <PolaroidStack current={current} />
      </div>
    </div>
  );
}

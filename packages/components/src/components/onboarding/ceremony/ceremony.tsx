import { useEffect } from 'react';
import * as stylex from '@stylexjs/stylex';
import { IntroSequence } from './intro-sequence';
import type { OnboardingAudio } from './use-onboarding-audio';
import { unlockSound } from './ui-sounds';

const styles = stylex.create({
  root: {
    position: 'fixed',
    inset: 0,
    zIndex: 10,
    overflow: 'hidden',
    color: 'var(--color-slate-950)',
  },
});

// The onboarding ceremony: the opening title sequence, and nothing else.
//
// It used to continue past the film into welcome/connect/showcase/done acts —
// a scripted tour with a fake agent run. The flow always mounted it with
// `stopAfterIntro`, so those acts were unreachable and have been removed; the
// real setup screens own everything the film hands off to.

export function OnboardingCeremony({
  /** Starts the film only after the containing window has finished revealing. */
  playing = true,
  /** Hands over to the next phase once the title sequence has played. */
  onFinish,
  audio,
}: {
  playing?: boolean;
  onFinish: () => void;
  audio: Pick<OnboardingAudio, 'start' | 'setEnergy' | 'setLayers'>;
}): React.JSX.Element {
  const { start: startAudio, setEnergy, setLayers } = audio;

  // The score comes up with the opening title, not with the onboarding, so the
  // ceremony has a beginning rather than just appearing.
  useEffect(() => {
    if (!playing) return undefined;
    startAudio();
    // Web Audio stays suspended until a real user gesture, and the overlay
    // opens without one — so the first touch of anything unlocks it. Without
    // this the foley is silent until whichever control happens to be pressed
    // first, which reads as "the sounds are broken".
    const unlock = (): void => {
      unlockSound();
      startAudio();
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, [playing, startAudio]);

  return (
    <div {...stylex.props(styles.root)}>
      <IntroSequence
        playing={playing}
        onStart={onFinish}
        setEnergy={setEnergy}
        setLayers={setLayers}
      />
    </div>
  );
}

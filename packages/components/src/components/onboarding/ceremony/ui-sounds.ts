import {
  defineSound,
  defineSequence,
  ensureReady,
  setMasterVolume,
  type SoundDefinition,
} from '@web-kits/audio';

// The ceremony's interaction sound palette, built with @web-kits/audio.
//
// This is deliberately separate from `use-onboarding-audio.ts`, which is the
// continuous SCORE (pad / arp / bass, driven by energy + layer mix). This file
// is the FOLEY: the sounds that respond to what the user does — every button,
// every choice, every cut. Two different jobs, two different lifetimes.
//
// Design rules, so this stays usable rather than annoying:
//   - Interaction sounds are short (<160ms) and quiet. They confirm, they do
//     not perform.
//   - Nothing plays that the user did not cause, except shot changes and
//     scripted product events in the onboarding films.
//   - Pitch carries meaning: forward motion rises, going back falls, trouble
//     sits on a flat minor second. A user should be able to tell the ceremony
//     is going well with their eyes shut.
//
// Everything is a pure data definition, so the whole palette can be read and
// re-tuned here without touching a component.

/**
 * Shared "material" for the UI.
 *
 * The first attempt was a bright white-noise tick at 2.4kHz over a 320Hz sine,
 * which is the generic plastic UI click — sharp, thin, and grating by the
 * twentieth press. This is a soft wooden knock instead: the noise is browner
 * and lowpassed well below the ear's harsh band, the body sits lower and drops
 * in pitch as it decays (which is what makes a real object sound struck rather
 * than beeped), and a quiet overtone gives it a little wood grain.
 */
const CLICK_BODY: SoundDefinition = {
  layers: [
    // The transient — dark, brief, felt more than heard.
    {
      source: { type: 'noise', color: 'brown' },
      filter: { type: 'lowpass', frequency: 1100, resonance: 0.7 },
      envelope: { attack: 0.0005, decay: 0.016 },
      gain: 0.1,
    },
    // The body — a struck knock, falling slightly in pitch.
    {
      source: { type: 'sine', frequency: { start: 210, end: 168 } },
      envelope: { attack: 0.001, decay: 0.085 },
      gain: 0.11,
    },
    // A touch of grain so it reads as a material, not a tone generator.
    {
      source: { type: 'triangle', frequency: 430 },
      filter: { type: 'lowpass', frequency: 1800 },
      envelope: { attack: 0.001, decay: 0.035 },
      gain: 0.028,
    },
  ],
};

/** A plain press. Every button in the ceremony uses this. */
const playClickRaw = defineSound(CLICK_BODY);

/** Pointer entering something choosable. Barely there on purpose. */
const playHoverRaw = defineSound({
  source: { type: 'sine', frequency: 720 },
  filter: { type: 'lowpass', frequency: 2200 },
  envelope: { attack: 0.004, decay: 0.05 },
  gain: 0.03,
});

/**
 * A choice being committed — the click, plus a rising fifth so "I picked this"
 * sounds different from "I pressed something".
 */
const playSelectRaw = defineSequence([
  { sound: CLICK_BODY, at: 0 },
  {
    sound: {
      source: { type: 'triangle', frequency: { start: 523.25, end: 784 } },
      envelope: { attack: 0.004, decay: 0.19 },
      gain: 0.1,
      effects: [{ type: 'reverb', mix: 0.22, decay: 1.1 }],
    },
    at: 0.02,
  },
]);

/** Going back / dismissing: the same gesture, falling. */
const playBackRaw = defineSequence([
  { sound: CLICK_BODY, at: 0 },
  {
    sound: {
      source: { type: 'triangle', frequency: { start: 523.25, end: 349.23 } },
      envelope: { attack: 0.004, decay: 0.17 },
      gain: 0.08,
    },
    at: 0.02,
  },
]);

/** A shot cutting to the next one. Air moving, not a note. */
const playCutRaw = defineSound({
  source: { type: 'noise', color: 'pink' },
  // A filter sweep is an envelope on the cutoff, not a frequency range.
  filter: {
    type: 'bandpass',
    frequency: 700,
    resonance: 0.8,
    envelope: { attack: 0.08, peak: 3200, decay: 0.34 },
  },
  envelope: { attack: 0.06, decay: 0.42 },
  gain: 0.075,
  effects: [{ type: 'reverb', mix: 0.3, decay: 1.6 }],
});

/** The brand landing — a bell triad, the one moment allowed to be pretty. */
const playRevealRaw = defineSequence([
  { sound: bell(659.25), at: 0 },
  { sound: bell(987.77), at: 0.09 },
  { sound: bell(1318.51), at: 0.19 },
]);

/** A struck bell: wavetable harmonics plus a long, quiet tail. */
function bell(frequency: number): SoundDefinition {
  return {
    source: { type: 'wavetable', harmonics: [1, 0.42, 0.18, 0.09, 0.04], frequency },
    envelope: { attack: 0.002, decay: 0.55 },
    gain: 0.085,
    effects: [{ type: 'reverb', mix: 0.34, decay: 2.2 }],
  };
}

/**
 * Wraps a sound so it can never take an interaction down with it.
 *
 * Foley is decoration on top of a real action. Web Audio is unavailable in some
 * environments and can refuse to start in others, and letting that propagate
 * out of a click handler means the button silently stops working — which is
 * exactly what happened: a `Next` press threw inside its sound and never ran
 * its own handler. Silence is an acceptable outcome; a dead button is not.
 */
function safe(play: () => unknown): () => void {
  return () => {
    try {
      play();
    } catch {
      // Deliberately swallowed.
    }
  };
}

export const playClick = safe(playClickRaw);
export const playHover = safe(playHoverRaw);
export const playSelect = safe(playSelectRaw);
export const playBack = safe(playBackRaw);
export const playCut = safe(playCutRaw);
export const playReveal = safe(playRevealRaw);

/**
 * Master level for the whole foley bus.
 *
 * Every sound above is authored at its own relative gain; this is the single
 * knob for "the interaction sounds are too loud", so tuning loudness never
 * means editing ten definitions and losing their balance against each other.
 * 0.7 is a deliberate 30% cut from the first pass, which sat too far forward.
 */
const FOLEY_VOLUME = 0.7;

/**
 * Web Audio will not start without a user gesture. The overlay opens without
 * one, so this is called from the first real interaction; until then every
 * `play*` above is a no-op rather than an error.
 */
export function unlockSound(): void {
  void ensureReady()
    .then(() => setMasterVolume(FOLEY_VOLUME))
    .catch((error: unknown) => {
      console.error('[onboarding] Failed to unlock ceremony sounds:', error);
    });
}

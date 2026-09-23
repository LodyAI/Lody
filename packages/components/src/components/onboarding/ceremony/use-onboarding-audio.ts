import { useCallback, useEffect, useRef, useState } from 'react';

// Procedural onboarding score via the Web Audio API.
//
// This is a small *sequenced* engine, not a drone: a look-ahead scheduler walks
// a chord progression and re-triggers every voice with its own envelope, so the
// music actually breathes and moves. Three independent layers can be faded in
// and out to follow the film:
//
//   pad   — sustained chord bed, re-voiced each bar (always on)
//   arp   — rhythmic arpeggio picking chord tones (rises during the showcase)
//   bass  — root notes on the strong beats (enters with the showcase)
//
// Generated in code on purpose: no bundled audio file, no licensing question,
// and the layers can be driven by the animation clock. To swap in a licensed
// track later, replace start/setLayers/playReveal with an <audio> element (and
// add `media-src` to onboarding.html's CSP) — call sites stay the same.
//
// Autoplay policy: a programmatically-opened window starts its AudioContext
// suspended. We attempt resume() and, if blocked, arm a one-time pointer/key
// listener and expose `needsGesture`.

type WindowWithWebkitAudio = Window & { webkitAudioContext?: typeof AudioContext };

const A4 = 440;
/** Semitone offset from A4 → Hz. */
function hz(semitones: number): number {
  return A4 * 2 ** (semitones / 12);
}

export type OnboardingAudioPreset = {
  id: string;
  label: string;
  /** Beats per minute for the scheduler. */
  tempo: number;
  /** Chord progression as semitone offsets from A4; one entry per bar. */
  progression: number[][];
  padWave: OscillatorType;
  arpWave: OscillatorType;
  bassWave: OscillatorType;
  /** Lowpass cutoff (Hz) on the pad bus — lower is warmer. */
  filterHz: number;
  /** Arp notes per beat (2 = eighths). 0 disables the arp layer. */
  arpSubdiv: number;
  /** Octave offset applied to arp notes. */
  arpOctave: number;
  /** Feedback-delay time in beats, and its feedback amount (0–0.7). */
  delayBeats: number;
  delayFeedback: number;
  /** Per-layer gain ceilings. */
  padGain: number;
  arpGain: number;
  bassGain: number;
};

// Chords are written as semitones from A4. e.g. -9 = C4, -5 = E4, -2 = G4.
export const ONBOARDING_AUDIO_PRESETS: OnboardingAudioPreset[] = [
  {
    id: 'warm',
    label: 'Warm',
    tempo: 72,
    // Cmaj9 → Amin7 → Fmaj7 → Gsus4
    progression: [
      [-9, -5, -2, 2, 5],
      [-12, -9, -5, -2, 3],
      [-16, -12, -9, -5, 0],
      [-14, -9, -7, -2, 3],
    ],
    padWave: 'triangle',
    arpWave: 'triangle',
    bassWave: 'sine',
    filterHz: 1700,
    arpSubdiv: 2,
    arpOctave: 12,
    delayBeats: 0.75,
    delayFeedback: 0.32,
    padGain: 0.075,
    arpGain: 0.085,
    bassGain: 0.11,
  },
  {
    id: 'ethereal',
    label: 'Ethereal',
    tempo: 58,
    // Suspended, slow-moving voicings.
    progression: [
      [-9, -2, 3, 7, 10],
      [-11, -4, 1, 5, 8],
      [-14, -7, -2, 3, 5],
      [-9, -2, 3, 7, 12],
    ],
    padWave: 'sine',
    arpWave: 'sine',
    bassWave: 'sine',
    filterHz: 2600,
    arpSubdiv: 1,
    arpOctave: 24,
    delayBeats: 1,
    delayFeedback: 0.45,
    padGain: 0.085,
    arpGain: 0.075,
    bassGain: 0.09,
  },
  {
    id: 'playful',
    label: 'Playful',
    tempo: 104,
    progression: [
      [-9, -5, -2, 3],
      [-7, -3, 0, 5],
      [-4, 0, 3, 7],
      [-5, -2, 2, 7],
    ],
    padWave: 'triangle',
    arpWave: 'square',
    bassWave: 'triangle',
    filterHz: 2200,
    arpSubdiv: 4,
    arpOctave: 12,
    delayBeats: 0.5,
    delayFeedback: 0.25,
    padGain: 0.055,
    arpGain: 0.08,
    bassGain: 0.115,
  },
  {
    id: 'cosmic',
    label: 'Cosmic',
    tempo: 50,
    progression: [
      [-21, -14, -9, -2, 5],
      [-19, -12, -7, 0, 7],
      [-23, -16, -11, -4, 3],
      [-21, -14, -9, -2, 10],
    ],
    padWave: 'sine',
    arpWave: 'triangle',
    bassWave: 'sine',
    filterHz: 900,
    arpSubdiv: 1,
    arpOctave: 24,
    delayBeats: 1.5,
    delayFeedback: 0.5,
    padGain: 0.09,
    arpGain: 0.07,
    bassGain: 0.13,
  },
  {
    id: 'minimal',
    label: 'Minimal',
    tempo: 64,
    progression: [
      [-9, -2, 3],
      [-9, -2, 3],
      [-11, -4, 1],
      [-11, -4, 1],
    ],
    padWave: 'sine',
    arpWave: 'sine',
    bassWave: 'sine',
    filterHz: 1500,
    arpSubdiv: 1,
    arpOctave: 12,
    delayBeats: 1,
    delayFeedback: 0.3,
    padGain: 0.07,
    arpGain: 0.065,
    bassGain: 0.085,
  },
];

// Deliberately conservative: this plays unprompted over whatever the user is
// doing, so it should sit under the room, not fill it.
const MASTER_TARGET = 0.34;
const FADE_SECONDS = 1.8;
const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD = 0.25; // seconds of audio scheduled in advance

export type AudioLayers = {
  pad: number;
  arp: number;
  bass: number;
};

/** One-shot punctuation sounds tied to keyframes. */
export type SfxKind = 'ding' | 'whoosh' | 'tick' | 'shimmer';

export type OnboardingAudio = {
  start: () => void;
  /**
   * Continuous "pen drawing" tone. Pass 0..1 while the stroke is being drawn
   * (the timbre rises with progress), or `null` to stop it.
   */
  setDrawTone: (progress: number | null) => void;
  /** Fire a one-shot punctuation sound. */
  sfx: (kind: SfxKind) => void;
  /**
   * Musical energy, 0..1. Drives a staged arrangement rather than a volume
   * knob: rhythmic density, bass activity, pad brightness and delay feedback
   * all move with it, so the score can build to something playful and then
   * settle back to calm.
   */
  setEnergy: (value: number) => void;
  /** Cross-fade the layer mix (0–1 each) — drives the film's dynamics. */
  setLayers: (layers: Partial<AudioLayers>) => void;
  /** Bell flourish for the mascot reveal. */
  playReveal: () => void;
  stop: (fadeSeconds?: number) => void;
  muted: boolean;
  toggleMuted: () => void;
  needsGesture: boolean;
  presetLabel: string;
  presetId: string;
  cyclePreset: () => void;
};

export function useOnboardingAudio(): OnboardingAudio {
  const ctxRef = useRef<AudioContext | null>(null);
  const masterRef = useRef<GainNode | null>(null);
  const busesRef = useRef<{ pad: GainNode; arp: GainNode; bass: GainNode } | null>(null);
  const timerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const noiseBufferRef = useRef<AudioBuffer | null>(null);
  const drawToneRef = useRef<{
    source: AudioBufferSourceNode;
    band: BiquadFilterNode;
    gain: GainNode;
  } | null>(null);
  const nextBeatRef = useRef(0);
  const beatRef = useRef(0);
  const startedRef = useRef(false);
  const mutedRef = useRef(false);
  const layersRef = useRef<AudioLayers>({ pad: 1, arp: 0, bass: 0 });
  const energyRef = useRef(0.12);
  const padFilterRef = useRef<BiquadFilterNode | null>(null);
  const presetIndexRef = useRef(0);
  const [presetIndex, setPresetIndex] = useState(0);
  const [muted, setMuted] = useState(false);
  const [needsGesture, setNeedsGesture] = useState(false);

  const preset = ONBOARDING_AUDIO_PRESETS[presetIndex] ?? ONBOARDING_AUDIO_PRESETS[0]!;

  const currentPreset = useCallback((): OnboardingAudioPreset => {
    return ONBOARDING_AUDIO_PRESETS[presetIndexRef.current] ?? ONBOARDING_AUDIO_PRESETS[0]!;
  }, []);

  /** One enveloped voice. Every note is its own oscillator — that's the breath. */
  const voice = useCallback(
    (
      ctx: AudioContext,
      dest: GainNode,
      opts: {
        freq: number;
        at: number;
        duration: number;
        wave: OscillatorType;
        peak: number;
        attack: number;
        release: number;
        detune?: number;
      }
    ): void => {
      const osc = ctx.createOscillator();
      osc.type = opts.wave;
      osc.frequency.value = opts.freq;
      if (opts.detune) osc.detune.value = opts.detune;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, opts.at);
      g.gain.linearRampToValueAtTime(opts.peak, opts.at + opts.attack);
      const sustainUntil = opts.at + Math.max(opts.attack, opts.duration - opts.release);
      g.gain.setValueAtTime(opts.peak, sustainUntil);
      g.gain.exponentialRampToValueAtTime(0.0005, opts.at + opts.duration);
      osc.connect(g);
      g.connect(dest);
      osc.start(opts.at);
      osc.stop(opts.at + opts.duration + 0.05);
    },
    []
  );

  /** Schedule everything that falls inside the look-ahead window. */
  const scheduler = useCallback((): void => {
    const ctx = ctxRef.current;
    const buses = busesRef.current;
    if (!ctx || !buses) return;
    const p = currentPreset();
    const beatDur = 60 / p.tempo;

    while (nextBeatRef.current < ctx.currentTime + SCHEDULE_AHEAD) {
      const at = nextBeatRef.current;
      const beat = beatRef.current;
      const bar = Math.floor(beat / 4);
      const beatInBar = beat % 4;
      const chord = p.progression[bar % p.progression.length]!;

      // Pad — re-voiced at the top of each bar with a long, overlapping swell.
      if (beatInBar === 0) {
        const barDur = beatDur * 4;
        for (const [i, semi] of chord.entries()) {
          voice(ctx, buses.pad, {
            freq: hz(semi),
            at,
            // Overlap into the next bar so chord changes glide.
            duration: barDur * 1.35,
            wave: p.padWave,
            peak: (p.padGain * 0.9) / (i * 0.45 + 1),
            attack: barDur * 0.42,
            release: barDur * 0.6,
            detune: (i % 2 === 0 ? 1 : -1) * 5,
          });
        }
      }

      // Bass — sparse when calm (downbeat only), driving when energetic.
      const energy = energyRef.current;
      const bassBeats = energy > 0.7 ? [0, 1, 2, 3] : energy > 0.35 ? [0, 2] : [0];
      if (bassBeats.includes(beatInBar)) {
        voice(ctx, buses.bass, {
          freq: hz(chord[0]! - 12),
          at,
          duration: beatDur * 1.6,
          wave: p.bassWave,
          peak: p.bassGain,
          attack: 0.05,
          release: beatDur * 1.2,
        });
      }

      // Arp — walks up and down the chord. Subdivision (and therefore how
      // busy/playful it feels) scales with energy, so the same preset can read
      // as a calm shimmer or a bright rhythmic figure.
      const subdiv =
        p.arpSubdiv <= 0
          ? 0
          : Math.max(1, Math.round(p.arpSubdiv * (energy > 0.7 ? 1 : energy > 0.35 ? 0.75 : 0.5)));
      if (subdiv > 0 && energy > 0.05) {
        const step = beatDur / subdiv;
        for (let s = 0; s < subdiv; s++) {
          const idx = (beat * subdiv + s) % (chord.length * 2 - 2 || 1);
          // Ping-pong through the chord tones for a musical contour.
          const tone = idx < chord.length ? idx : chord.length * 2 - 2 - idx;
          voice(ctx, buses.arp, {
            freq: hz(chord[tone]! + p.arpOctave),
            at: at + s * step,
            duration: step * 2.2,
            wave: p.arpWave,
            peak: p.arpGain * (s === 0 ? 1 : 0.7) * (0.55 + energy * 0.6),
            attack: 0.01,
            release: step * 1.6,
          });
        }
      }

      nextBeatRef.current = at + beatDur;
      beatRef.current = beat + 1;
    }
  }, [currentPreset, voice]);

  const buildGraph = useCallback(
    (ctx: AudioContext, master: GainNode): void => {
      const p = currentPreset();
      const beatDur = 60 / p.tempo;

      // A feedback delay gives the score depth without a convolver/IR asset.
      const delay = ctx.createDelay(4);
      delay.delayTime.value = Math.min(3.5, p.delayBeats * beatDur);
      const feedback = ctx.createGain();
      feedback.gain.value = p.delayFeedback;
      const delayWet = ctx.createGain();
      delayWet.gain.value = 0.32;
      const delayIn = ctx.createGain();
      delayIn.connect(delay);
      delay.connect(feedback);
      feedback.connect(delay);
      delay.connect(delayWet);
      delayWet.connect(master);

      const padFilter = ctx.createBiquadFilter();
      padFilter.type = 'lowpass';
      padFilter.frequency.value = p.filterHz;
      padFilter.Q.value = 0.5;
      padFilter.connect(master);
      padFilterRef.current = padFilter;

      const pad = ctx.createGain();
      pad.gain.value = layersRef.current.pad;
      pad.connect(padFilter);

      // Each layer is tone-shaped into its own register so the parts stay
      // distinguishable instead of blending into one wash: the arp is
      // high-passed with a presence lift and pushed into the delay so it
      // sparkles out in front, while the bass is low-passed hard so it is felt
      // rather than heard. Without this every layer occupies the same band and
      // "more layers" just sounds louder, not richer.
      const arpHighPass = ctx.createBiquadFilter();
      arpHighPass.type = 'highpass';
      arpHighPass.frequency.value = 520;
      const arpPresence = ctx.createBiquadFilter();
      arpPresence.type = 'peaking';
      arpPresence.frequency.value = 2400;
      arpPresence.Q.value = 0.9;
      arpPresence.gain.value = 5;
      arpHighPass.connect(arpPresence);
      arpPresence.connect(master);
      arpPresence.connect(delayIn);

      const arp = ctx.createGain();
      arp.gain.value = layersRef.current.arp;
      arp.connect(arpHighPass);

      const bassLowPass = ctx.createBiquadFilter();
      bassLowPass.type = 'lowpass';
      bassLowPass.frequency.value = 220;
      bassLowPass.Q.value = 0.7;
      bassLowPass.connect(master);

      const bass = ctx.createGain();
      bass.gain.value = layersRef.current.bass;
      bass.connect(bassLowPass);

      busesRef.current = { pad, arp, bass };
    },
    [currentPreset]
  );

  const ensureContext = useCallback((): AudioContext | null => {
    if (ctxRef.current) return ctxRef.current;
    const Ctor = window.AudioContext ?? (window as WindowWithWebkitAudio).webkitAudioContext;
    if (!Ctor) return null;
    const ctx = new Ctor();
    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);
    ctxRef.current = ctx;
    masterRef.current = master;
    return ctx;
  }, []);

  const teardownVoices = useCallback((): void => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const start = useCallback((): void => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    const ctx = ensureContext();
    const master = masterRef.current;
    if (!ctx || !master) return;

    const begin = (): void => {
      teardownVoices();
      buildGraph(ctx, master);
      nextBeatRef.current = ctx.currentTime + 0.08;
      beatRef.current = 0;
      startedRef.current = true;
      scheduler();
      timerRef.current = window.setInterval(scheduler, LOOKAHEAD_MS);
      const now = ctx.currentTime;
      master.gain.cancelScheduledValues(now);
      master.gain.setValueAtTime(master.gain.value, now);
      master.gain.linearRampToValueAtTime(mutedRef.current ? 0 : MASTER_TARGET, now + FADE_SECONDS);
      setNeedsGesture(false);
    };

    if (ctx.state === 'suspended') {
      void ctx.resume().then(begin, () => {
        setNeedsGesture(true);
        const onGesture = (): void => {
          window.removeEventListener('pointerdown', onGesture);
          window.removeEventListener('keydown', onGesture);
          void ctx.resume().then(begin, () => undefined);
        };
        window.addEventListener('pointerdown', onGesture, { once: true });
        window.addEventListener('keydown', onGesture, { once: true });
      });
      return;
    }
    begin();
  }, [ensureContext, teardownVoices, buildGraph, scheduler]);

  const setEnergy = useCallback(
    (value: number): void => {
      const next = value <= 0 ? 0 : value >= 1 ? 1 : value;
      if (Math.abs(next - energyRef.current) < 0.01) return;
      energyRef.current = next;
      const ctx = ctxRef.current;
      const filter = padFilterRef.current;
      if (!ctx || !filter) return;
      // Brighter pad as the piece lifts, darker as it settles.
      const p = currentPreset();
      filter.frequency.setTargetAtTime(p.filterHz * (0.55 + next * 0.85), ctx.currentTime, 0.6);
    },
    [currentPreset]
  );

  const setLayers = useCallback((next: Partial<AudioLayers>): void => {
    layersRef.current = { ...layersRef.current, ...next };
    const ctx = ctxRef.current;
    const buses = busesRef.current;
    if (!ctx || !buses) return;
    const now = ctx.currentTime;
    for (const key of ['pad', 'arp', 'bass'] as const) {
      const value = layersRef.current[key];
      const node = buses[key];
      // Only re-ramp when the target actually moved, so this is cheap to call
      // from a per-frame effect.
      if (Math.abs(node.gain.value - value) < 0.005) continue;
      node.gain.cancelScheduledValues(now);
      node.gain.setValueAtTime(node.gain.value, now);
      node.gain.linearRampToValueAtTime(value, now + 1.1);
    }
  }, []);

  const playReveal = useCallback((): void => {
    const ctx = ctxRef.current;
    const buses = busesRef.current;
    if (!ctx || !buses || ctx.state !== 'running' || mutedRef.current) return;
    const p = currentPreset();
    const chord = p.progression[0]!;
    const base = ctx.currentTime + 0.02;
    // A rising flourish over the current chord, into the delay for shimmer.
    chord.slice(0, 4).forEach((semi, i) => {
      voice(ctx, buses.arp, {
        freq: hz(semi + p.arpOctave + 12),
        at: base + i * 0.11,
        duration: 1.5,
        wave: 'sine',
        peak: 0.1,
        attack: 0.012,
        release: 1.3,
      });
    });
  }, [currentPreset, voice]);

  /** Shared white-noise buffer, built once and reused by the draw tone + sfx. */
  const noiseBuffer = useCallback((ctx: AudioContext): AudioBuffer => {
    const existing = noiseBufferRef.current;
    if (existing && existing.sampleRate === ctx.sampleRate) return existing;
    const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 2), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    noiseBufferRef.current = buffer;
    return buffer;
  }, []);

  /**
   * Continuous stroke-drawing tone: band-passed noise whose centre frequency
   * and level track the draw progress, so the outline "sounds" like it is being
   * inked rather than just appearing.
   */
  const setDrawTone = useCallback(
    (progress: number | null): void => {
      const ctx = ctxRef.current;
      const master = masterRef.current;
      if (!ctx || !master || ctx.state !== 'running') return;

      if (progress === null) {
        const active = drawToneRef.current;
        if (active) {
          const now = ctx.currentTime;
          active.gain.gain.cancelScheduledValues(now);
          active.gain.gain.setValueAtTime(active.gain.gain.value, now);
          active.gain.gain.linearRampToValueAtTime(0, now + 0.18);
          try {
            active.source.stop(now + 0.22);
          } catch {
            // Already stopped.
          }
          drawToneRef.current = null;
        }
        return;
      }

      let active = drawToneRef.current;
      if (!active) {
        const source = ctx.createBufferSource();
        source.buffer = noiseBuffer(ctx);
        source.loop = true;
        const band = ctx.createBiquadFilter();
        band.type = 'bandpass';
        band.Q.value = 6;
        band.frequency.value = 900;
        const gain = ctx.createGain();
        gain.gain.value = 0;
        source.connect(band);
        band.connect(gain);
        gain.connect(master);
        source.start();
        active = { source, band, gain };
        drawToneRef.current = active;
      }

      const now = ctx.currentTime;
      // Rises ~900Hz -> ~2.6kHz as the outline completes; stays quiet.
      active.band.frequency.setTargetAtTime(900 + progress * 1700, now, 0.05);
      active.gain.gain.setTargetAtTime(mutedRef.current ? 0 : 0.05, now, 0.06);
    },
    [noiseBuffer]
  );

  /** One-shot punctuation for keyframe moments. */
  const sfx = useCallback(
    (kind: SfxKind): void => {
      const ctx = ctxRef.current;
      const master = masterRef.current;
      if (!ctx || !master || ctx.state !== 'running' || mutedRef.current) return;
      const now = ctx.currentTime + 0.01;

      if (kind === 'ding') {
        // Bell: a fundamental plus a slightly inharmonic partial, long decay.
        for (const [i, mult] of [1, 2.76].entries()) {
          const osc = ctx.createOscillator();
          osc.type = 'sine';
          osc.frequency.value = 1046.5 * mult;
          const g = ctx.createGain();
          g.gain.setValueAtTime(0, now);
          g.gain.linearRampToValueAtTime(i === 0 ? 0.16 : 0.05, now + 0.006);
          g.gain.exponentialRampToValueAtTime(0.0005, now + (i === 0 ? 2.2 : 1.2));
          osc.connect(g);
          g.connect(master);
          osc.start(now);
          osc.stop(now + 2.4);
        }
        return;
      }

      if (kind === 'whoosh' || kind === 'shimmer') {
        const isShimmer = kind === 'shimmer';
        const source = ctx.createBufferSource();
        source.buffer = noiseBuffer(ctx);
        const band = ctx.createBiquadFilter();
        band.type = 'bandpass';
        band.Q.value = isShimmer ? 3 : 1.2;
        const dur = isShimmer ? 1.1 : 0.55;
        band.frequency.setValueAtTime(isShimmer ? 1800 : 300, now);
        band.frequency.exponentialRampToValueAtTime(isShimmer ? 5200 : 1800, now + dur);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, now);
        g.gain.linearRampToValueAtTime(isShimmer ? 0.07 : 0.1, now + 0.06);
        g.gain.exponentialRampToValueAtTime(0.0005, now + dur);
        source.connect(band);
        band.connect(g);
        g.connect(master);
        source.start(now);
        source.stop(now + dur + 0.05);
        return;
      }

      // tick — a very short soft click to mark a scene change.
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(2200, now);
      osc.frequency.exponentialRampToValueAtTime(900, now + 0.06);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(0.05, now + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0004, now + 0.12);
      osc.connect(g);
      g.connect(master);
      osc.start(now);
      osc.stop(now + 0.15);
    },
    [noiseBuffer]
  );

  const stop = useCallback(
    (fadeSeconds = 0.4): void => {
      teardownVoices();
      setDrawTone(null);
      const ctx = ctxRef.current;
      const master = masterRef.current;
      if (!ctx || !master) return;
      const now = ctx.currentTime;
      const fadeDuration = Math.max(0.4, fadeSeconds);
      master.gain.cancelScheduledValues(now);
      master.gain.setValueAtTime(master.gain.value, now);
      master.gain.linearRampToValueAtTime(0, now + fadeDuration);
      startedRef.current = false;
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = window.setTimeout(
        () => {
          void ctx.close().catch((error: unknown) => {
            console.error('[onboarding] Failed to close the ceremony audio context:', error);
          });
          ctxRef.current = null;
          masterRef.current = null;
          busesRef.current = null;
          closeTimerRef.current = null;
        },
        fadeDuration * 1000 + 200
      );
    },
    [teardownVoices, setDrawTone]
  );

  const toggleMuted = useCallback((): void => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    const ctx = ctxRef.current;
    const master = masterRef.current;
    if (ctx && master && startedRef.current) {
      const now = ctx.currentTime;
      master.gain.cancelScheduledValues(now);
      master.gain.setValueAtTime(master.gain.value, now);
      master.gain.linearRampToValueAtTime(next ? 0 : MASTER_TARGET, now + 0.35);
    }
  }, []);

  const cyclePreset = useCallback((): void => {
    const next = (presetIndexRef.current + 1) % ONBOARDING_AUDIO_PRESETS.length;
    presetIndexRef.current = next;
    setPresetIndex(next);
    if (startedRef.current) start();
  }, [start]);

  useEffect(() => {
    return () => stop();
  }, [stop]);

  return {
    start,
    setEnergy,
    setDrawTone,
    sfx,
    setLayers,
    playReveal,
    stop,
    muted,
    toggleMuted,
    needsGesture,
    presetLabel: preset.label,
    presetId: preset.id,
    cyclePreset,
  };
}

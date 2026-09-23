import {
  isModifierKey,
  normalizeHotkeyFromParsed,
  normalizeKeyName,
  parseKeyboardEvent,
  PUNCTUATION_CODE_MAP,
} from '@tanstack/hotkeys';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getHotkeyPlatform } from './platform';
import { commands } from './registry';
import { setGlobalShortcutsSuspended } from '@/lib/native-global-shortcuts';

const SETTLE_AFTER_CAPTURE_MS = 1000;

/**
 * Normalize an event with the same library used by command dispatch. Modifier-only
 * events use a temporary key so the library can still produce the live preview order.
 *
 * `allowModifierOnly: true` lets a modifiers-only event return a partial string for
 * live preview during recording; the default (false) returns `null` so callers can
 * cleanly skip incomplete combos.
 */
function buildBindingString(
  event: KeyboardEvent,
  { allowModifierOnly = false }: { allowModifierOnly?: boolean } = {}
): string | null {
  const isModifierEvent = isModifierKey(normalizeKeyName(event.key));
  if (isModifierEvent && !allowModifierOnly) return null;
  const platform = getHotkeyPlatform();
  if (!isModifierEvent) {
    const parsed = parseKeyboardEvent(event);
    const code = event.code;
    if (/^Key[A-Z]$/.test(code)) parsed.key = code.slice(3);
    else if (/^(?:Digit|Numpad)[0-9]$/.test(code)) parsed.key = code.slice(-1);
    else if (PUNCTUATION_CODE_MAP[code]) parsed.key = PUNCTUATION_CODE_MAP[code];
    return normalizeHotkeyFromParsed(parsed, platform);
  }

  const preview = normalizeHotkeyFromParsed(
    { ...parseKeyboardEvent(event), key: 'F24' },
    platform
  ).replace(/\+?F24$/, '');
  return preview || null;
}

/** One-shot encode for callers outside the recording lifecycle. */
export function eventToBindingString(event: KeyboardEvent): string | null {
  return buildBindingString(event);
}

export type KeyCaptureStatus = 'idle' | 'recording';

export type KeyCaptureOptions = {
  /**
   * Fired once a complete combo has been captured (last modifier released).
   *
   * Return `false` to reject the combo — the hook will clear its captured state and
   * stay in recording mode so the user can immediately retry without re-clicking.
   * Use this to validate against e.g. collisions with other bindings. Any other return
   * value (including void) accepts the combo and exits recording, with the registry's
   * dispatch staying suspended for a short settle window.
   */
  onCapture: (binding: string) => boolean | void;
  /** Fired when the user presses Escape without modifiers, or when focus is lost. */
  onCancel?: () => void;
};

export type KeyCaptureControls = {
  status: KeyCaptureStatus;
  /**
   * Live preview of the keys currently held during recording — `null` when recording is
   * idle or no key is currently held. Use this to render a kbd chip group that updates
   * as the user presses modifiers/keys.
   */
  preview: string | null;
  start: () => void;
  cancel: () => void;
};

/**
 * Only one row may be recording at a time across the whole page. Each `useKeyCapture`
 * instance attaches its own capture-phase key listeners while recording, so without this
 * guard clicking a second row's record button would leave two recorders capturing the
 * same keypress. Starting a recording cancels whoever was recording before.
 */
let activeCaptureCancel: (() => void) | null = null;

/**
 * Records a key combo by watching the press-then-release cycle. Final binding is
 * committed when the last modifier is released, then dispatch stays suspended for a
 * settle window so the just-released keys don't re-trigger the freshly-bound command.
 *
 * Combo state is derived from per-event modifier flags, not an accumulated pressed-keys
 * Set: macOS suppresses `keyup` for non-modifier keys while ⌘ is held, so any per-key
 * accumulator never drains. Modifier flags on every event always reflect ground truth.
 */
export function useKeyCapture({ onCapture, onCancel }: KeyCaptureOptions): KeyCaptureControls {
  const [status, setStatus] = useState<KeyCaptureStatus>('idle');
  const [preview, setPreview] = useState<string | null>(null);
  const onCaptureRef = useRef(onCapture);
  const onCancelRef = useRef(onCancel);
  onCaptureRef.current = onCapture;
  onCancelRef.current = onCancel;

  const cancel = useCallback(() => {
    setStatus('idle');
    setPreview(null);
    onCancelRef.current?.();
  }, []);
  const start = useCallback(() => {
    // Stop any other row that was recording, so only this one listens.
    if (activeCaptureCancel && activeCaptureCancel !== cancel) {
      activeCaptureCancel();
    }
    activeCaptureCancel = cancel;
    setStatus('recording');
  }, [cancel]);

  useEffect(() => {
    if (status !== 'recording') return undefined;
    if (typeof window === 'undefined') return undefined;

    // The registry is a capture-phase listener attached earlier than ours on the same
    // target, so stopImmediatePropagation here would be too late. Pause it up front and
    // rely on that; stopImmediatePropagation remains as a defensive net.
    commands.setPaused(true);
    // OS global shortcuts fire app-wide and would otherwise swallow the keypress (and
    // trigger their action) before the renderer sees it. Suspend them while recording so
    // the combo reaches us — and can be flagged as occupied rather than acted on.
    setGlobalShortcutsSuspended(true);

    let latestValid: string | null = null;
    let currentPreview: string | null = null;
    let cooldownScheduled = false;

    const setPreviewIfChanged = (next: string | null) => {
      if (next === currentPreview) return;
      currentPreview = next;
      setPreview(next);
    };

    const noModifiersHeld = (event: KeyboardEvent): boolean =>
      !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;

    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      if (event.key === 'Escape' && noModifiersHeld(event)) {
        setStatus('idle');
        setPreviewIfChanged(null);
        onCancelRef.current?.();
        return;
      }

      const combo = buildBindingString(event, { allowModifierOnly: true });
      if (combo) setPreviewIfChanged(combo);
      if (combo && !isModifierKey(normalizeKeyName(event.key))) {
        latestValid = combo;
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();

      // event.{meta,ctrl,alt,shift}Key on keyup is post-event state: true ↔ that
      // modifier is still held AFTER this release. Wait until all are false → user is
      // done with this combo. Robust to release order and to macOS's swallowed keyups.
      if (!noModifiersHeld(event)) return;

      if (latestValid) {
        const captured = latestValid;
        latestValid = null;
        // Validator runs before we settle so a rejection can keep us in recording mode
        // (registry stays paused) for the user to retry without re-clicking.
        const accepted = onCaptureRef.current(captured) !== false;
        if (!accepted) {
          setPreviewIfChanged(null);
          return;
        }
        cooldownScheduled = true;
        commands.pauseFor(SETTLE_AFTER_CAPTURE_MS);
        setStatus('idle');
        setPreviewIfChanged(null);
        return;
      }

      setPreviewIfChanged(null);
    };

    const handleBlur = () => {
      setStatus('idle');
      setPreviewIfChanged(null);
      onCancelRef.current?.();
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    window.addEventListener('keyup', handleKeyUp, { capture: true });
    window.addEventListener('blur', handleBlur);

    return () => {
      // Release our claim on the single active recording (unless another row already
      // took over via start()).
      if (activeCaptureCancel === cancel) {
        activeCaptureCancel = null;
      }
      // Re-arm OS global shortcuts now that recording is over.
      setGlobalShortcutsSuspended(false);
      // Skip the un-pause if a cooldown is in flight — otherwise the keys the user is
      // still releasing would fire the freshly-bound command.
      if (!cooldownScheduled) {
        commands.setPaused(false);
      }
      window.removeEventListener('keydown', handleKeyDown, {
        capture: true,
      } as EventListenerOptions);
      window.removeEventListener('keyup', handleKeyUp, {
        capture: true,
      } as EventListenerOptions);
      window.removeEventListener('blur', handleBlur);
    };
  }, [status, cancel]);

  return { status, preview, start, cancel };
}

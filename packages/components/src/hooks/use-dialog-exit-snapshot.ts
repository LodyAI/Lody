import { useCallback, useState } from 'react';

/**
 * What a dialog opened by a value (`open={value !== null}`) renders while it
 * closes.
 *
 * Such a dialog closes by clearing its value, and the panel only then starts to
 * fade out. Rendered from the live value, its body is gone in the first frame
 * and the panel collapses to its header while it fades — the content blinks out
 * before the panel does. `shown` is the last value the dialog was open with,
 * kept until Base UI reports the close finished through the root's
 * `onOpenChangeComplete`, which the caller hands on.
 *
 * `open` stays on the live value: only what is drawn outlives it.
 */
export function useDialogExitSnapshot<T>(value: T | null): {
  shown: T | null;
  onOpenChangeComplete: (open: boolean) => void;
} {
  const [kept, setKept] = useState<T | null>(value);
  if (value !== null && value !== kept) setKept(value);
  const onOpenChangeComplete = useCallback((open: boolean) => {
    if (!open) setKept(null);
  }, []);
  return { shown: value ?? kept, onOpenChangeComplete };
}

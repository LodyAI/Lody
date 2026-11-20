import type { KeyboardEvent } from 'react';
import { isImeComposingKeyboardEvent } from '@/lib/ime';
import {
  normalizeMobileKeyboardAction,
  shouldSubmitOnEnterForMobileKeyboardAction,
} from '@/lib/mobile-keyboard-action';
import type { ComposerInputElement } from '@/ui/mention/composer-input';

/**
 * Enter in a chat composer.
 *
 * Desktop submits; Shift+Enter is left for the editor or textarea to turn
 * into a newline. A soft keyboard submits only when the user chose Send.
 * The mention editor inserts the newline when this returns without
 * preventing the key. A plain textarea keeps the browser newline.
 */
export function handleComposerEnterKey(
  event: KeyboardEvent<ComposerInputElement>,
  options: {
    softKeyboard: boolean;
    action: unknown;
    onSubmit: () => void;
    /** Mod+Shift+Enter. The session composer uses it to invert queue/steer. */
    onInvertSubmit?: () => void;
  }
): void {
  if (event.key !== 'Enter' || isImeComposingKeyboardEvent(event)) return;
  if (options.onInvertSubmit && event.shiftKey && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    options.onInvertSubmit();
    return;
  }
  if (
    !shouldSubmitOnEnterForMobileKeyboardAction({
      action: normalizeMobileKeyboardAction(options.action),
      isMobile: options.softKeyboard,
      shiftKey: event.shiftKey,
    })
  ) {
    return;
  }
  event.preventDefault();
  options.onSubmit();
}

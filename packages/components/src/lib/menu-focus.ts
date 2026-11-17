import type { ComposerInputElement } from '@/ui/mention/composer-input';
/**
 * Shared post-menu focus policy for composer-adjacent pickers.
 *
 * Radix DropdownMenu / Popover restore focus to the trigger on close by default.
 * That is correct for pure keyboard Esc-out, but wrong after the user has made a
 * selection (or dismissed by clicking into the prompt): the next Enter re-opens
 * the menu instead of submitting the composer.
 */

/** Prompt textarea marker used by chat landing + session composer. */
export const COMPOSER_FOCUS_SELECTOR = '[data-keyboard-nav="composer"]';

export function isTextInputElement(el: Element | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName === 'INPUT') {
    const type = (el as HTMLInputElement).type.toLowerCase();
    return ['text', 'search', 'url', 'email', 'password', 'tel', 'number'].includes(type);
  }
  return Boolean(el.isContentEditable);
}

/**
 * Return keyboard focus to the visible composer prompt, if any.
 * No-ops inside an open dialog so settings/auth surfaces keep their focus.
 */
export function restoreComposerFocusAfterMenu(): boolean {
  if (typeof document === 'undefined') return false;
  if (
    document.querySelector(
      '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]'
    )
  ) {
    return false;
  }
  const composer = document.querySelector<ComposerInputElement>(COMPOSER_FOCUS_SELECTOR);
  if (!composer) return false;
  if (
    composer instanceof HTMLTextAreaElement
      ? composer.disabled
      : composer.hasAttribute('data-disabled')
  ) {
    return false;
  }
  composer.focus({ preventScroll: true });
  return true;
}

/**
 * Handle Radix `onCloseAutoFocus` after a menu/popover closes.
 *
 * - Selection (or keep-open interaction that marked selection): never return to
 *   the trigger; restore the composer when present.
 * - Pointer dismiss onto another control (including the prompt): leave that
 *   focus alone instead of stealing it back to the trigger.
 * - Keyboard Esc with focus still inside the menu: leave default trigger restore.
 */
export function handleMenuCloseAutoFocus(
  event: Event,
  options: {
    didSelectItem: boolean;
    menuContent: EventTarget | null;
  }
): void {
  if (options.didSelectItem) {
    event.preventDefault();
    restoreComposerFocusAfterMenu();
    return;
  }

  const active = document.activeElement;
  const content = options.menuContent;
  if (!(active instanceof HTMLElement) || active === document.body) return;
  if (content instanceof Element && (content === active || content.contains(active))) return;
  // Outside target already received focus (click-to-dismiss into prompt/button).
  event.preventDefault();
}

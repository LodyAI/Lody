export const MOBILE_KEYBOARD_ACTIONS = ['send', 'newline'] as const;

export type MobileKeyboardAction = (typeof MOBILE_KEYBOARD_ACTIONS)[number];
export type MobileKeyboardEnterKeyHint = 'send' | 'enter';

/**
 * A phone keyboard has no Shift+Enter. Return inserts a newline unless the
 * user explicitly chooses Send.
 */
export const DEFAULT_MOBILE_KEYBOARD_ACTION: MobileKeyboardAction = 'newline';

export function isMobileKeyboardAction(value: unknown): value is MobileKeyboardAction {
  return value === 'send' || value === 'newline';
}

export function normalizeMobileKeyboardAction(value: unknown): MobileKeyboardAction {
  return isMobileKeyboardAction(value) ? value : DEFAULT_MOBILE_KEYBOARD_ACTION;
}

export function resolveMobileKeyboardEnterKeyHint(
  action: unknown,
  isMobile: boolean
): MobileKeyboardEnterKeyHint {
  return isMobile && normalizeMobileKeyboardAction(action) === 'newline' ? 'enter' : 'send';
}

export function shouldSubmitOnEnterForMobileKeyboardAction({
  action,
  isMobile,
  shiftKey,
}: {
  action: unknown;
  isMobile: boolean;
  shiftKey: boolean;
}): boolean {
  if (shiftKey) {
    return false;
  }

  return !(isMobile && normalizeMobileKeyboardAction(action) === 'newline');
}

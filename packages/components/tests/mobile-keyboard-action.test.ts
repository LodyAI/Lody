// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MOBILE_KEYBOARD_ACTION,
  normalizeMobileKeyboardAction,
  shouldSubmitOnEnterForMobileKeyboardAction,
} from '../src/lib/mobile-keyboard-action';
import { prefersSoftKeyboardEnterPolicy } from '../src/hooks/use-mobile';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';

function setNavigator(userAgent: string) {
  Object.defineProperty(window.navigator, 'userAgent', {
    configurable: true,
    value: userAgent,
  });
}

describe('mobile keyboard Return policy', () => {
  afterEach(() => {
    Reflect.deleteProperty(window.navigator, 'userAgent');
    Reflect.deleteProperty(window, '__LODY_ELECTRON__');
    Reflect.deleteProperty(window, '__LODY_NATIVE__');
  });

  it('defaults to a newline and keeps an explicit send choice', () => {
    expect(DEFAULT_MOBILE_KEYBOARD_ACTION).toBe('newline');
    expect(normalizeMobileKeyboardAction(undefined)).toBe('newline');
    expect(normalizeMobileKeyboardAction('send')).toBe('send');
    expect(normalizeMobileKeyboardAction('nope')).toBe('newline');
  });

  it('submits on desktop Enter and not on Shift+Enter', () => {
    expect(
      shouldSubmitOnEnterForMobileKeyboardAction({
        action: 'newline',
        isMobile: false,
        shiftKey: false,
      })
    ).toBe(true);
    expect(
      shouldSubmitOnEnterForMobileKeyboardAction({
        action: 'send',
        isMobile: false,
        shiftKey: true,
      })
    ).toBe(false);
  });

  it('inserts a newline on a soft keyboard unless Send is chosen', () => {
    expect(
      shouldSubmitOnEnterForMobileKeyboardAction({
        action: 'newline',
        isMobile: true,
        shiftKey: false,
      })
    ).toBe(false);
    expect(
      shouldSubmitOnEnterForMobileKeyboardAction({
        action: 'send',
        isMobile: true,
        shiftKey: false,
      })
    ).toBe(true);
    expect(
      shouldSubmitOnEnterForMobileKeyboardAction({
        action: 'send',
        isMobile: true,
        shiftKey: true,
      })
    ).toBe(false);
  });

  it('follows a phone identity even when the window is wide, and not Electron', () => {
    setNavigator(IPHONE);
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 900 });
    expect(prefersSoftKeyboardEnterPolicy()).toBe(true);

    setNavigator('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
    expect(prefersSoftKeyboardEnterPolicy()).toBe(false);

    setNavigator(IPHONE);
    Object.defineProperty(window, '__LODY_ELECTRON__', { configurable: true, value: true });
    expect(prefersSoftKeyboardEnterPolicy()).toBe(false);
  });
});

import { Capacitor } from '@capacitor/core';
import { Keyboard } from '@capacitor/keyboard';

declare global {
  interface Window {
    __LODY_NATIVE_VIEWPORT__?: boolean;
  }
}

/**
 * Initializes native keyboard handling for the Capacitor shell.
 *
 * Sets the CSS custom property `--native-keyboard-height` on <html> so shared
 * components can add bottom padding when the iOS soft keyboard is visible.
 *
 * Current iOS shells publish the window-local keyboard layout guide from
 * LodyBridgeViewController, including changes while folding or resizing.
 * Keep the Capacitor event path for older shells and Android.
 *
 * iOS honors Capacitor's `resize: "none"` and the viewport meta tag uses
 * `interactive-widget=overlaps-content`, so the WebView is not resized by the
 * OS. Instead, we manually offset the input area using this CSS variable.
 *
 * Android does not support the Keyboard `resize` mode; `resizeOnFullScreen`
 * explicitly makes the WebView resize there. Keep the CSS variable at 0 on
 * Android so the native resize and our layout padding do not both move inputs.
 */
export function initNativeKeyboard(): void {
  const root = document.documentElement;
  const usesManualKeyboardOffset = Capacitor.getPlatform() === 'ios';
  if (usesManualKeyboardOffset && window.__LODY_NATIVE_VIEWPORT__) return;
  root.style.setProperty('--native-keyboard-height', '0px');

  void Keyboard.addListener('keyboardWillShow', (info) => {
    const layoutOffset = usesManualKeyboardOffset ? info.keyboardHeight : 0;
    root.style.setProperty('--native-keyboard-height', `${layoutOffset}px`);
    window.dispatchEvent(
      new CustomEvent('lody:keyboard-resize', { detail: { height: info.keyboardHeight } })
    );
  });

  void Keyboard.addListener('keyboardWillHide', () => {
    root.style.setProperty('--native-keyboard-height', '0px');
    window.dispatchEvent(new CustomEvent('lody:keyboard-resize', { detail: { height: 0 } }));
  });
}

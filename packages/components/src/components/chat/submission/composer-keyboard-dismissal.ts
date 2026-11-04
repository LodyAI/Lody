/** Let the committed message surface paint before starting native keyboard motion. */
export function dismissComposerKeyboardAfterPaint(input: HTMLTextAreaElement) {
  const document = input.ownerDocument;
  const window = document.defaultView;
  if (!window) return () => {};
  let frame = 0;
  const cancel = () => {
    window.cancelAnimationFrame(frame);
    document.removeEventListener('pointerdown', cancel, true);
    document.removeEventListener('focusin', cancel, true);
    document.removeEventListener('visibilitychange', cancel);
    input.removeEventListener('keydown', cancel, true);
    input.removeEventListener('beforeinput', cancel, true);
    input.removeEventListener('compositionstart', cancel, true);
    window.removeEventListener('blur', cancel);
  };
  document.addEventListener('pointerdown', cancel, true);
  document.addEventListener('focusin', cancel, true);
  document.addEventListener('visibilitychange', cancel);
  input.addEventListener('keydown', cancel, true);
  input.addEventListener('beforeinput', cancel, true);
  input.addEventListener('compositionstart', cancel, true);
  window.addEventListener('blur', cancel);
  // One frame presents the new content; the following frame starts dismissal.
  // This follows a real commit, rather than guessing readiness with a timeout.
  frame = window.requestAnimationFrame(() => {
    frame = window.requestAnimationFrame(() => {
      cancel();
      if (input.isConnected && document.activeElement === input) input.blur();
    });
  });
  return cancel;
}

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { installFocusModality } from '../src/focus/focus-modality';
import { focus } from '../src/tokens/scales.stylex';

const ringWidthVar = /var\((--[^),\s]+)/.exec(focus.ringWidth)?.[1] ?? '';
const root = document.documentElement;
const ringWidth = () => root.style.getPropertyValue(ringWidthVar);
const key = (target: EventTarget, name: string) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));

describe('installFocusModality', () => {
  let uninstall: () => void;
  beforeEach(() => {
    uninstall = installFocusModality();
  });
  afterEach(() => uninstall());

  test('starts in pointer mode with every ring that reads the token at zero width', () => {
    expect(ringWidthVar).not.toBe('');
    expect(root.dataset.focusModality).toBe('pointer');
    expect(ringWidth()).toBe('0px');
  });

  test('Tab brings the rings back and a pointer press takes them away again', () => {
    key(document.body, 'Tab');
    expect(root.dataset.focusModality).toBe('keyboard');
    expect(ringWidth()).toBe('');

    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(root.dataset.focusModality).toBe('pointer');
    expect(ringWidth()).toBe('0px');
  });

  test('Escape and Enter act rather than navigate, so they leave a pointer user without rings', () => {
    key(document.body, 'Escape');
    key(document.body, 'Enter');
    expect(root.dataset.focusModality).toBe('pointer');
  });

  test('arrow keys inside a text field move the caret, not focus', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    key(input, 'ArrowLeft');
    expect(root.dataset.focusModality).toBe('pointer');
    key(document.body, 'ArrowDown');
    expect(root.dataset.focusModality).toBe('keyboard');
    input.remove();
  });

  test('uninstalling leaves the document as it found it', () => {
    uninstall();
    expect(root.dataset.focusModality).toBeUndefined();
    expect(ringWidth()).toBe('');
    uninstall = () => {};
  });
});

import { useEffect, useState } from 'react';

type Division = { left: number; width: number; viewportWidth: number };
export type HorizontalDivision = { top: number; height: number; viewportHeight: number };

declare global {
  interface Window {
    __LODY_VERTICAL_DIVISION__?: Division | null;
    __LODY_HORIZONTAL_DIVISION__?: HorizontalDivision | null;
  }
}

function readDivision(): Division | null {
  if (typeof window === 'undefined') return null;
  const value = window.__LODY_VERTICAL_DIVISION__;
  if (
    !value ||
    !Number.isFinite(value.left) ||
    !Number.isFinite(value.width) ||
    !Number.isFinite(value.viewportWidth) ||
    value.left <= 0 ||
    value.width <= 0 ||
    value.left + value.width >= value.viewportWidth
  )
    return null;
  return value;
}

/** UIKit supplies view-relative geometry; web and older iOS builds stay unchanged. */
export function useVerticalDivision(): Division | null {
  const [division, setDivision] = useState(readDivision);
  useEffect(() => {
    const update = () => setDivision(readDivision());
    window.addEventListener('lody:division-change', update);
    update();
    return () => window.removeEventListener('lody:division-change', update);
  }, []);
  return division;
}

function readHorizontalDivision(): HorizontalDivision | null {
  if (typeof window === 'undefined') return null;
  const value = window.__LODY_HORIZONTAL_DIVISION__;
  if (
    !value ||
    !Number.isFinite(value.top) ||
    !Number.isFinite(value.height) ||
    !Number.isFinite(value.viewportHeight) ||
    value.top <= 0 ||
    value.height <= 0 ||
    value.top + value.height >= value.viewportHeight
  )
    return null;
  return value;
}

export function useHorizontalDivision(): HorizontalDivision | null {
  const [division, setDivision] = useState(readHorizontalDivision);
  useEffect(() => {
    const update = () => setDivision(readHorizontalDivision());
    window.addEventListener('lody:division-change', update);
    update();
    return () => window.removeEventListener('lody:division-change', update);
  }, []);
  return division;
}

/** Cap a sheet to the lower panel; keyboard-aware sheets can suspend the cap. */
export function useFoldAwareSheetHeight(fallbackPercent = 85, suspendForKeyboard = false): string {
  const division = useHorizontalDivision();
  const readKeyboard = () =>
    typeof document !== 'undefined' &&
    (parseFloat(document.documentElement.style.getPropertyValue('--native-keyboard-height')) || 0) >
      0;
  const [keyboardVisible, setKeyboardVisible] = useState(readKeyboard);
  useEffect(() => {
    if (!suspendForKeyboard) return undefined;
    const update = () => setKeyboardVisible(readKeyboard());
    window.addEventListener('lody:keyboard-resize', update);
    update();
    return () => window.removeEventListener('lody:keyboard-resize', update);
  }, [suspendForKeyboard]);
  if (suspendForKeyboard && keyboardVisible) return `${fallbackPercent}dvh`;
  const lowerHeight = division ? division.viewportHeight - division.top - division.height : 0;
  return lowerHeight >= 240 &&
    lowerHeight < (division?.viewportHeight ?? 0) * (fallbackPercent / 100)
    ? `${lowerHeight}px`
    : `${fallbackPercent}dvh`;
}

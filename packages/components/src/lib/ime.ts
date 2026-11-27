interface ImeAwareKeyboardEvent {
  key: string;
  nativeEvent: Omit<NativeImeAwareKeyboardEvent, 'key'>;
}

interface NativeImeAwareKeyboardEvent {
  key: string;
  isComposing?: boolean;
  keyCode?: number;
  which?: number;
}

/**
 * IME composition detection for keydown handlers.
 *
 * `nativeEvent.isComposing` is the primary signal, but some browsers/IMEs
 * only expose composition via key=Process or keyCode/which=229.
 */
export function isImeComposingKeyboardEvent(event: ImeAwareKeyboardEvent): boolean {
  return isImeComposingNativeKeyboardEvent({
    key: event.key,
    isComposing: event.nativeEvent.isComposing,
    keyCode: event.nativeEvent.keyCode,
    which: event.nativeEvent.which,
  });
}

/**
 * Native-event variant for window/document listeners and Radix dismiss layers.
 */
export function isImeComposingNativeKeyboardEvent(event: NativeImeAwareKeyboardEvent): boolean {
  if (event.isComposing) return true;
  if (event.key === 'Process') return true;

  return event.keyCode === 229 || event.which === 229;
}

interface DuplicatedImeCommitEchoInput {
  nextValue: string;
  lastStableComposingValue: string;
  inputType?: string;
  isComposing?: boolean;
  committedData?: string;
}

interface CompositionInsertTextEchoInput {
  nextValue: string;
  committedData?: string;
  inputType?: string;
  compositionStartValue: string;
  compositionStartSelectionStart: number;
  compositionStartSelectionEnd: number;
  lastStableComposingValue: string;
}

/**
 * Detect iOS WeChat IME duplicated commit echo in this shape:
 * stable composing value "token" -> onChange(insertFromComposition, isComposing=true) "tokentoken".
 *
 * When this happens, the real committed value is usually the single copy.
 */
export function resolveDuplicatedImeCommitEcho({
  nextValue,
  lastStableComposingValue,
  inputType,
  isComposing,
  committedData,
}: DuplicatedImeCommitEchoInput): string | null {
  if (inputType !== 'insertFromComposition') return null;
  if (!isComposing) return null;
  if (committedData && nextValue === `${committedData}${committedData}`) {
    return committedData;
  }
  if (lastStableComposingValue === '') return null;
  if (nextValue !== `${lastStableComposingValue}${lastStableComposingValue}`) return null;
  return lastStableComposingValue;
}

/**
 * Resolve iOS WeChat IME insertText commit echo:
 * compositionEnd reports stale preedit text, then input(insertText, data=<commit>)
 * appends committed text after the stale preedit ("ni h你好").
 *
 * In that case we reconstruct the committed value from composition-start snapshot.
 *
 * IMPORTANT: This should only trigger when the committed data matches what was
 * reported in compositionEnd. If the input data doesn't match the composition
 * result (e.g., user pressed space after Chinese input), we should not intervene.
 */
export function resolveCompositionInsertTextEcho({
  nextValue,
  committedData,
  inputType,
  compositionStartValue,
  compositionStartSelectionStart,
  compositionStartSelectionEnd,
  lastStableComposingValue,
}: CompositionInsertTextEchoInput): string | null {
  if (inputType !== 'insertText') return null;
  if (!committedData) return null;

  // Check if this is a regular keystroke after composition ended (e.g., space, punctuation).
  // When user presses space/punctuation right after CJK composition:
  // - committedData is the single character typed (" ", "。", etc.)
  // - lastStableComposingValue is the final CJK result (e.g., "一二三")
  // These are unrelated, so we should not treat this as a commit echo.
  const isWhitespaceOrSinglePunctuation = /^\s$|^[^\w\s]$/.test(committedData);
  const composingValueIsCjk =
    lastStableComposingValue && /[\u4e00-\u9fa5]/.test(lastStableComposingValue);
  const isUnrelatedToComposition =
    isWhitespaceOrSinglePunctuation &&
    composingValueIsCjk &&
    !lastStableComposingValue.includes(committedData) &&
    !committedData.includes(lastStableComposingValue);
  if (isUnrelatedToComposition) {
    return null;
  }

  const max = compositionStartValue.length;
  const start = Math.max(0, Math.min(max, compositionStartSelectionStart));
  const end = Math.max(start, Math.min(max, compositionStartSelectionEnd));
  const committedValue =
    compositionStartValue.slice(0, start) + committedData + compositionStartValue.slice(end);

  if (committedValue === nextValue) {
    return committedValue;
  }

  if (!lastStableComposingValue) return null;

  const hasPreeditEcho =
    nextValue.includes(lastStableComposingValue) &&
    nextValue.endsWith(committedData) &&
    committedValue.length < nextValue.length;
  if (!hasPreeditEcho) return null;

  return committedValue;
}

/**
 * Generic duplicated-half detection used by awaiting-commit fallback paths.
 */
export function resolveDuplicatedHalfValue(value: string, base: string): string | null {
  if (base === '') return null;
  if (value !== `${base}${base}`) return null;
  return base;
}

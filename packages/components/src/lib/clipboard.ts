/**
 * Native clipboard installed by WebView app shells as `window.__LODY_CLIPBOARD__`.
 *
 * Android System WebView never grants `navigator.clipboard.readText()` and grants
 * `writeText()` only while the click's transient user activation is still live,
 * which an awaited fetch or export easily outlives. The shell therefore routes
 * plain-text clipboard access through the platform clipboard instead.
 */
export type LodyClipboardBridge = {
  writeText: (text: string) => Promise<void>;
  /** Resolves `null` when the clipboard holds no text. */
  readText: () => Promise<string | null>;
};

const nativeClipboard = (): LodyClipboardBridge | undefined =>
  typeof window === 'undefined'
    ? undefined
    : (window as Window & { __LODY_CLIPBOARD__?: LodyClipboardBridge }).__LODY_CLIPBOARD__;

const copyWithSelection = (text: string): boolean => {
  if (typeof document === 'undefined') {
    return false;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '-9999px';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';

  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
};

/**
 * Copy `text` to the clipboard, rejecting when every route fails. Use it in
 * place of `navigator.clipboard.writeText`.
 *
 * Order: the native shell clipboard, then the async Clipboard API, then a
 * hidden-`<textarea>` + `document.execCommand('copy')` selection copy for
 * insecure contexts and browsers that reject `navigator.clipboard`.
 */
export const copyTextToClipboard = async (text: string): Promise<void> => {
  const native = nativeClipboard();
  if (native) {
    await native.writeText(text);
    return;
  }

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the selection-based copy path below.
    }
  }

  if (!copyWithSelection(text)) {
    throw new Error('Clipboard write failed');
  }
};

/**
 * Copy `text` to the clipboard, returning whether it succeeded. Safe to call
 * in non-DOM environments — returns `false` instead of throwing.
 */
export const writeTextToClipboard = async (text: string): Promise<boolean> => {
  try {
    await copyTextToClipboard(text);
    return true;
  } catch {
    return false;
  }
};

/** Read plain text from the clipboard; `null` when empty or access is denied. */
export const readTextFromClipboard = async (): Promise<string | null> => {
  try {
    const native = nativeClipboard();
    if (native) {
      return await native.readText();
    }
    return (await navigator.clipboard?.readText?.()) ?? null;
  } catch {
    return null;
  }
};

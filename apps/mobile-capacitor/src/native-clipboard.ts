import { Clipboard } from '@capacitor/clipboard';

/**
 * Same shape as `LodyClipboardBridge` in `@lody/components/lib/clipboard`,
 * declared here so the shell compiles against an OSS pin that predates it.
 */
type NativeClipboardBridge = {
  writeText: (text: string) => Promise<void>;
  readText: () => Promise<string | null>;
};

/**
 * Routes shared copy/paste through the platform clipboard. Android System
 * WebView never grants `navigator.clipboard.readText()` and rejects
 * `writeText()` once the click's user activation has lapsed (for example
 * after an awaited export), so the WebView API cannot serve native shells.
 */
export function initNativeClipboardBridge(): void {
  (window as Window & { __LODY_CLIPBOARD__?: NativeClipboardBridge }).__LODY_CLIPBOARD__ = {
    writeText: (text) => Clipboard.write({ string: text }),
    readText: async () => {
      try {
        const { type, value } = await Clipboard.read();
        // Images come back as data URLs; only text is pasteable here.
        return type.startsWith('image/') ? null : value;
      } catch {
        // The plugin rejects when the clipboard is empty.
        return null;
      }
    },
  };
}

import iconv from 'iconv-lite';

/**
 * Windows OEM code page mapping by locale.
 * These are the most common code pages for different language versions of Windows.
 *
 * Reference: https://docs.microsoft.com/en-us/windows/win32/intl/code-page-identifiers
 */
const WINDOWS_OEM_CODE_PAGES: Record<string, string> = {
  'zh-CN': 'cp936',
  'zh-TW': 'cp950',
  'zh-HK': 'cp950',
  'ja-JP': 'cp932',
  'ko-KR': 'cp949',
  'ru-RU': 'cp866',
  'uk-UA': 'cp866',
  'bg-BG': 'cp866',
  'en-US': 'cp437',
  'de-DE': 'cp850',
  'fr-FR': 'cp850',
  'es-ES': 'cp850',
  'it-IT': 'cp850',
  'pt-BR': 'cp850',
  'pt-PT': 'cp850',
  'pl-PL': 'cp852',
  'cs-CZ': 'cp852',
  'hu-HU': 'cp852',
  'ro-RO': 'cp852',
  'tr-TR': 'cp857',
  'he-IL': 'cp862',
  'ar-SA': 'cp720',
  'th-TH': 'cp874',
  'vi-VN': 'cp1258',
};

/**
 * Default OEM code page when locale cannot be determined.
 * CP437 is the original IBM PC code page.
 */
const DEFAULT_OEM_CODE_PAGE = 'cp437';

let cachedLocale: string | null = null;
let cachedOemCodePage: string | null = null;

/**
 * Detects the system locale from environment variables.
 *
 * On Windows, the locale can be determined from:
 * - LANG environment variable (if set by user)
 * - LC_ALL environment variable
 * - LOCALE environment variable
 * - PowerShell's $PSCulture (not directly accessible)
 *
 * Falls back to 'en-US' if no locale can be detected.
 */
function detectSystemLocale(): string {
  if (cachedLocale !== null) {
    return cachedLocale;
  }

  const envLocale =
    process.env.LANG || process.env.LC_ALL || process.env.LC_CTYPE || process.env.LOCALE;

  if (envLocale) {
    const match = envLocale.match(/^([a-z]{2})[-_]([A-Z]{2})/i);
    if (match && match[1] && match[2]) {
      cachedLocale = `${match[1].toLowerCase()}-${match[2].toUpperCase()}`;
      return cachedLocale;
    }
  }

  cachedLocale = 'en-US';
  return cachedLocale;
}

/**
 * Gets the OEM code page for the current Windows system.
 *
 * The OEM code page is used by console applications (cmd.exe, etc.)
 * for stdout/stderr output. This differs from the ANSI code page
 * used by GUI applications.
 */
export function getWindowsOemCodePage(): string {
  if (cachedOemCodePage !== null) {
    return cachedOemCodePage;
  }

  const locale = detectSystemLocale();
  cachedOemCodePage = WINDOWS_OEM_CODE_PAGES[locale] || DEFAULT_OEM_CODE_PAGE;
  return cachedOemCodePage;
}

/**
 * Checks if a buffer contains valid UTF-8 data.
 *
 * This uses a heuristic approach:
 * 1. Check for UTF-8 BOM
 * 2. Validate UTF-8 byte sequences
 * 3. Check for common non-UTF-8 patterns
 *
 * @param buffer - The buffer to check
 * @returns true if the buffer appears to be valid UTF-8
 */
export function isValidUtf8(buffer: Buffer): boolean {
  if (buffer.length === 0) {
    return true;
  }

  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return true;
  }

  let i = 0;
  while (i < buffer.length) {
    const byte = buffer[i];
    if (byte === undefined) break;

    if (byte <= 0x7f) {
      i++;
    } else if ((byte & 0xe0) === 0xc0) {
      if (i + 1 >= buffer.length) return false;
      const byte2 = buffer[i + 1];
      if (byte2 === undefined || (byte2 & 0xc0) !== 0x80) return false;
      if (byte < 0xc2) return false;
      i += 2;
    } else if ((byte & 0xf0) === 0xe0) {
      if (i + 2 >= buffer.length) return false;
      const byte2 = buffer[i + 1];
      const byte3 = buffer[i + 2];
      if (byte2 === undefined || byte3 === undefined) return false;
      if ((byte2 & 0xc0) !== 0x80 || (byte3 & 0xc0) !== 0x80) return false;
      const codePoint = ((byte & 0x0f) << 12) | ((byte2 & 0x3f) << 6) | (byte3 & 0x3f);
      if (codePoint < 0x800 || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return false;
      i += 3;
    } else if ((byte & 0xf8) === 0xf0) {
      if (i + 3 >= buffer.length) return false;
      const byte2 = buffer[i + 1];
      const byte3 = buffer[i + 2];
      const byte4 = buffer[i + 3];
      if (byte2 === undefined || byte3 === undefined || byte4 === undefined) return false;
      if ((byte2 & 0xc0) !== 0x80 || (byte3 & 0xc0) !== 0x80 || (byte4 & 0xc0) !== 0x80)
        return false;
      const codePoint =
        ((byte & 0x07) << 18) | ((byte2 & 0x3f) << 12) | ((byte3 & 0x3f) << 6) | (byte4 & 0x3f);
      if (codePoint < 0x10000 || codePoint > 0x10ffff) return false;
      i += 4;
    } else {
      return false;
    }
  }

  return true;
}

/**
 * Decodes a buffer to a string, handling Windows encoding issues.
 *
 * On Windows, child process output may use the system OEM code page
 * (e.g., CP936 for Simplified Chinese) instead of UTF-8. This function
 * attempts to detect and handle this by:
 *
 * 1. First trying to decode as UTF-8
 * 2. If the buffer doesn't look like valid UTF-8 and we're on Windows,
 *    falling back to the system's OEM code page
 *
 * @param buffer - The buffer to decode
 * @param forceEncoding - Optional encoding to force (bypasses detection)
 * @returns The decoded string
 */
export function decodeBuffer(buffer: Buffer, forceEncoding?: string): string {
  if (buffer.length === 0) {
    return '';
  }

  if (forceEncoding) {
    return iconv.decode(buffer, forceEncoding);
  }

  if (process.platform !== 'win32') {
    return buffer.toString('utf8');
  }

  if (isValidUtf8(buffer)) {
    return buffer.toString('utf8');
  }

  const codePage = getWindowsOemCodePage();
  return iconv.decode(buffer, codePage);
}

export function setWindowsOemCodePageForTesting(codePage: string | null): void {
  cachedOemCodePage = codePage;
}

export function setLocaleForTesting(locale: string | null): void {
  cachedLocale = locale;
}

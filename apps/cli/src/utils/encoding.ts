import { spawnSync } from 'node:child_process';
import { win32 as pathWin32 } from 'node:path';
import iconv from 'iconv-lite';

/**
 * Windows OEM code page mapping by locale.
 * These are the most common code pages for different language versions of Windows.
 *
 * Reference: https://docs.microsoft.com/en-us/windows/win32/intl/code-page-identifiers
 */
const WINDOWS_OEM_CODE_PAGES: Record<string, string> = {
  // East Asian
  'zh-CN': 'cp936', // Simplified Chinese (GBK)
  'zh-TW': 'cp950', // Traditional Chinese (Big5)
  'zh-HK': 'cp950', // Traditional Chinese (Big5)
  'ja-JP': 'cp932', // Japanese (Shift-JIS)
  'ko-KR': 'cp949', // Korean

  // Cyrillic
  'ru-RU': 'cp866', // Russian
  'uk-UA': 'cp866', // Ukrainian
  'bg-BG': 'cp866', // Bulgarian

  // Western European
  'en-US': 'cp437', // US English (DOS)
  'de-DE': 'cp850', // German
  'fr-FR': 'cp850', // French
  'es-ES': 'cp850', // Spanish
  'it-IT': 'cp850', // Italian
  'pt-BR': 'cp850', // Portuguese (Brazil)
  'pt-PT': 'cp850', // Portuguese (Portugal)

  // Central/Eastern European
  'pl-PL': 'cp852', // Polish
  'cs-CZ': 'cp852', // Czech
  'hu-HU': 'cp852', // Hungarian
  'ro-RO': 'cp852', // Romanian

  // Other
  'tr-TR': 'cp857', // Turkish
  'he-IL': 'cp862', // Hebrew
  'ar-SA': 'cp720', // Arabic
  'th-TH': 'cp874', // Thai
  'vi-VN': 'cp1258', // Vietnamese
};

const WINDOWS_OEM_CODE_PAGES_BY_LANGUAGE: Readonly<Record<string, string>> = {
  ar: 'cp720',
  bg: 'cp866',
  cs: 'cp852',
  de: 'cp850',
  en: 'cp437',
  es: 'cp850',
  fr: 'cp850',
  he: 'cp862',
  hu: 'cp852',
  it: 'cp850',
  ja: 'cp932',
  ko: 'cp949',
  pl: 'cp852',
  pt: 'cp850',
  ro: 'cp852',
  ru: 'cp866',
  th: 'cp874',
  tr: 'cp857',
  uk: 'cp866',
  vi: 'cp1258',
};

/**
 * Default OEM code page when locale cannot be determined.
 * CP437 is the original IBM PC code page.
 */
const DEFAULT_OEM_CODE_PAGE = 'cp437';
const CHCP_TIMEOUT_MS = 2_000;
const CHCP_MAX_BUFFER_BYTES = 64 * 1024;
const CHCP_RETRY_DELAY_MS = 30_000;
const CHCP_SUCCESS_CACHE_MS = 5 * 60_000;
const WINDOWS_CODE_PAGE_ALIASES: Readonly<Record<number, string>> = {
  54936: 'gb18030',
  65001: 'utf8',
};

/**
 * Cached system locale (detected once at startup).
 */
let cachedLocale: string | null = null;

/**
 * Cached OEM code page for the current system.
 */
let cachedOemCodePage: string | null = null;
let cachedOemCodePageExpiresAt = 0;
let nextOemCodePageProbeAt = 0;

/**
 * Converts environment-style locale values to canonical BCP 47 tags.
 */
function normalizeLocale(value: string | undefined): Intl.Locale | null {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0 || /^(?:C|POSIX)(?:[.@]|$)/i.test(trimmed)) {
    return null;
  }

  const languageTag = trimmed.split(/[.@]/, 1)[0]?.replaceAll('_', '-');
  if (languageTag === undefined || languageTag.length === 0) {
    return null;
  }

  try {
    return new Intl.Locale(languageTag);
  } catch {
    return null;
  }
}

/**
 * Detects the system locale from standard locale variables, then Intl.
 */
function detectSystemLocale(): string {
  if (cachedLocale !== null) {
    return cachedLocale;
  }

  const candidates = [
    process.env.LC_ALL,
    process.env.LC_CTYPE,
    process.env.LANG,
    process.env.LOCALE,
  ];

  try {
    candidates.push(Intl.DateTimeFormat().resolvedOptions().locale);
  } catch {
    // Intl may be unavailable in a reduced Node.js build.
  }

  for (const candidate of candidates) {
    const locale = normalizeLocale(candidate);
    if (locale) {
      cachedLocale = locale.toString();
      return cachedLocale;
    }
  }

  cachedLocale = 'en-US';
  return cachedLocale;
}

/**
 * Resolves a locale to a known Windows OEM code page.
 */
function resolveLocaleCodePage(localeName: string): string {
  const locale = normalizeLocale(localeName);
  if (!locale) {
    return DEFAULT_OEM_CODE_PAGE;
  }

  const exactMatch = WINDOWS_OEM_CODE_PAGES[locale.baseName];
  if (exactMatch !== undefined) {
    return exactMatch;
  }

  if (locale.language === 'zh') {
    return locale.script === 'Hant' || ['TW', 'HK', 'MO'].includes(locale.region ?? '')
      ? 'cp950'
      : 'cp936';
  }

  return WINDOWS_OEM_CODE_PAGES_BY_LANGUAGE[locale.language] ?? DEFAULT_OEM_CODE_PAGE;
}

/**
 * Parses the final code-page-shaped number from localized chcp output.
 */
function parseChcpCodePage(output: Buffer): number | null {
  const value = /^[^\r\n]*:\s*(\d{3,5})\s*$/.exec(output.toString('latin1'))?.[1];
  if (value === undefined) {
    return null;
  }

  const codePage = Number.parseInt(value, 10);
  return Number.isSafeInteger(codePage) ? codePage : null;
}

function normalizeLocalWindowsDirectory(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (trimmed === undefined || !/^[A-Za-z]:\\[^\\/:*?"<>|]+\\?$/.test(trimmed)) {
    return null;
  }

  const withoutTrailingSlash = trimmed.endsWith('\\') ? trimmed.slice(0, -1) : trimmed;
  const directoryName = pathWin32.basename(withoutTrailingSlash);
  return directoryName === '.' || directoryName === '..' ? null : withoutTrailingSlash;
}

function resolveWindowsCommandProcessor(): string | null {
  const configuredDirectories = [process.env.SystemRoot, process.env.WINDIR].filter(
    (value): value is string => value !== undefined && value.trim().length > 0
  );
  if (configuredDirectories.length === 0) {
    return null;
  }

  const normalizedDirectories = configuredDirectories.map(normalizeLocalWindowsDirectory);
  if (normalizedDirectories.some((directory) => directory === null)) {
    return null;
  }

  const windowsDirectory = normalizedDirectories[0];
  if (windowsDirectory === undefined || windowsDirectory === null) {
    return null;
  }
  if (
    normalizedDirectories.some(
      (directory) => directory?.toLowerCase() !== windowsDirectory.toLowerCase()
    )
  ) {
    return null;
  }

  const commandProcessor = pathWin32.join(windowsDirectory, 'System32', 'cmd.exe');
  if (process.env.ComSpec?.trim().toLowerCase() !== commandProcessor.toLowerCase()) {
    return null;
  }

  return commandProcessor;
}

/**
 * Probes cmd.exe for the console's active OEM code page.
 */
function probeWindowsOemCodePage(): string | null {
  try {
    const commandProcessor = resolveWindowsCommandProcessor();
    if (commandProcessor === null) {
      return null;
    }

    const result = spawnSync(commandProcessor, ['/d', '/s', '/c', 'chcp'], {
      encoding: null,
      windowsHide: true,
      timeout: CHCP_TIMEOUT_MS,
      maxBuffer: CHCP_MAX_BUFFER_BYTES,
    });

    if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
      return null;
    }

    const codePage = parseChcpCodePage(result.stdout);
    if (codePage === null) {
      return null;
    }
    const alias = WINDOWS_CODE_PAGE_ALIASES[codePage];
    if (alias !== undefined) {
      return iconv.encodingExists(alias) ? alias : null;
    }

    const encoding = `cp${codePage}`;
    return iconv.encodingExists(encoding) ? encoding : null;
  } catch {
    return null;
  }
}

/**
 * Gets the OEM code page for the current Windows system.
 *
 * The OEM code page is used by console applications (cmd.exe, etc.)
 * for stdout/stderr output. This differs from the ANSI code page
 * used by GUI applications.
 */
export function getWindowsOemCodePage(): string {
  const now = Date.now();
  if (cachedOemCodePage !== null && now < cachedOemCodePageExpiresAt) {
    return cachedOemCodePage;
  }

  if (process.platform === 'win32') {
    if (now >= nextOemCodePageProbeAt) {
      const detectedCodePage = probeWindowsOemCodePage();
      if (detectedCodePage !== null) {
        cachedOemCodePage = detectedCodePage;
        cachedOemCodePageExpiresAt = now + CHCP_SUCCESS_CACHE_MS;
        return cachedOemCodePage;
      }
      nextOemCodePageProbeAt = now + CHCP_RETRY_DELAY_MS;
    }

    if (cachedOemCodePage !== null) {
      return cachedOemCodePage;
    }
  }

  cachedOemCodePage = null;
  return resolveLocaleCodePage(detectSystemLocale());
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
  // Empty buffer is valid UTF-8
  if (buffer.length === 0) {
    return true;
  }

  // Check for UTF-8 BOM
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    // Has UTF-8 BOM, likely UTF-8
    return true;
  }

  // Validate UTF-8 byte sequences
  let i = 0;
  while (i < buffer.length) {
    const byte = buffer[i];
    if (byte === undefined) break;

    if (byte <= 0x7f) {
      // ASCII (0x00-0x7F)
      i++;
    } else if ((byte & 0xe0) === 0xc0) {
      // 2-byte sequence (0xC0-0xDF)
      if (i + 1 >= buffer.length) return false;
      const byte2 = buffer[i + 1];
      if (byte2 === undefined || (byte2 & 0xc0) !== 0x80) return false;
      // Check for overlong encoding
      if (byte < 0xc2) return false;
      i += 2;
    } else if ((byte & 0xf0) === 0xe0) {
      // 3-byte sequence (0xE0-0xEF)
      if (i + 2 >= buffer.length) return false;
      const byte2 = buffer[i + 1];
      const byte3 = buffer[i + 2];
      if (byte2 === undefined || byte3 === undefined) return false;
      if ((byte2 & 0xc0) !== 0x80 || (byte3 & 0xc0) !== 0x80) return false;
      // Check for overlong encoding and surrogate pairs
      const codePoint = ((byte & 0x0f) << 12) | ((byte2 & 0x3f) << 6) | (byte3 & 0x3f);
      if (codePoint < 0x800 || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return false;
      i += 3;
    } else if ((byte & 0xf8) === 0xf0) {
      // 4-byte sequence (0xF0-0xF7)
      if (i + 3 >= buffer.length) return false;
      const byte2 = buffer[i + 1];
      const byte3 = buffer[i + 2];
      const byte4 = buffer[i + 3];
      if (byte2 === undefined || byte3 === undefined || byte4 === undefined) return false;
      if ((byte2 & 0xc0) !== 0x80 || (byte3 & 0xc0) !== 0x80 || (byte4 & 0xc0) !== 0x80)
        return false;
      // Check for overlong encoding and valid range
      const codePoint =
        ((byte & 0x07) << 18) | ((byte2 & 0x3f) << 12) | ((byte3 & 0x3f) << 6) | (byte4 & 0x3f);
      if (codePoint < 0x10000 || codePoint > 0x10ffff) return false;
      i += 4;
    } else {
      // Invalid UTF-8 start byte
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
  // Empty buffer
  if (buffer.length === 0) {
    return '';
  }

  // If a specific encoding is forced, use it
  if (forceEncoding !== undefined && forceEncoding.length > 0) {
    return iconv.decode(buffer, forceEncoding);
  }

  // On non-Windows platforms, always use UTF-8
  if (process.platform !== 'win32') {
    return buffer.toString('utf8');
  }

  // On Windows, check if the buffer is valid UTF-8
  if (isValidUtf8(buffer)) {
    return buffer.toString('utf8');
  }

  // Buffer is not valid UTF-8, use the system's OEM code page
  const codePage = getWindowsOemCodePage();
  return iconv.decode(buffer, codePage);
}

/**
 * Sets the cached OEM code page for testing purposes.
 *
 * @param codePage - The code page to set (e.g., 'cp936', 'utf8')
 */
export function setWindowsOemCodePageForTesting(codePage: string | null): void {
  cachedOemCodePage = codePage;
  cachedOemCodePageExpiresAt = codePage === null ? 0 : Number.POSITIVE_INFINITY;
  nextOemCodePageProbeAt = 0;
}

/**
 * Sets the cached locale for testing purposes.
 *
 * @param locale - The locale to set (e.g., 'zh-CN', 'en-US')
 */
export function setLocaleForTesting(locale: string | null): void {
  cachedLocale = locale;
}

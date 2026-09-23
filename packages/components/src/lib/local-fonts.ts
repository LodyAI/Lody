interface LocalFontMetadata {
  family: string;
}

export type QueryLocalFonts = () => Promise<readonly LocalFontMetadata[]>;

export const INTERFACE_FONT_CSS_VARIABLE = '--lody-interface-font-family';

export function isSymbolFontFamily(family: string): boolean {
  return /^(?:Webdings|Wingdings(?:\s*[23])?|Symbol|Zapf\s*Dingbats)$/i.test(family.trim());
}

function quoteCssFontFamily(fontFamily: string): string {
  return `"${fontFamily.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/** CSS font-family value with the bundled interface stack retained as fallback. */
export function buildInterfaceFontFamily(fontFamily: string): string {
  return fontFamily
    ? `${quoteCssFontFamily(fontFamily)}, var(--font-sans-default)`
    : 'var(--font-sans-default)';
}

export function applyInterfaceFontFamily(root: HTMLElement, fontFamily: string): void {
  if (fontFamily) {
    root.style.setProperty(INTERFACE_FONT_CSS_VARIABLE, buildInterfaceFontFamily(fontFamily));
  } else {
    root.style.removeProperty(INTERFACE_FONT_CSS_VARIABLE);
  }
}

function getBrowserFontQuery(): QueryLocalFonts {
  if (typeof window === 'undefined') {
    throw new Error('Local fonts are unavailable outside the browser');
  }

  const queryLocalFonts = (window as Window & { queryLocalFonts?: QueryLocalFonts })
    .queryLocalFonts;
  if (typeof queryLocalFonts !== 'function') {
    throw new Error('Local Font Access API is unavailable');
  }
  return queryLocalFonts.bind(window);
}

/** Enumerate unique system font families from Chromium's Local Font Access API. */
export async function listSystemFontFamilies(
  queryLocalFonts: QueryLocalFonts = getBrowserFontQuery()
): Promise<string[]> {
  const fonts = await queryLocalFonts();
  const families = new Map<string, string>();

  for (const font of fonts) {
    const family = font.family.trim();
    if (!family || isSymbolFontFamily(family)) continue;
    const key = family.toLowerCase();
    if (!families.has(key)) families.set(key, family);
  }

  return [...families.values()].sort((left, right) =>
    left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })
  );
}

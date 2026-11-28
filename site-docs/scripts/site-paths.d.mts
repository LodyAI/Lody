export const SITE_URL: string;

export const SITE_LOCALES: readonly ['en', 'zh', 'zh-hant', 'ja', 'ko', 'es', 'fr', 'ru'];

export function localePrefix(locale: string): string;

export function detectPathLocale(sitePath: string): string;

export function stripLocalePrefix(sitePath: string): { locale: string; basePath: string };

export function slugFromMdxFile(file: string, rootDir: string): string;

export function collectSitePathSources(packageRoot: string): Map<string, string[]>;

export function collectSitePaths(packageRoot: string): string[];

export function isSitemapPath(sitePath: string): boolean;

export function absoluteSiteUrl(sitePath: string): string;

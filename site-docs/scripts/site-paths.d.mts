export const SITE_URL: string;

export function slugFromMdxFile(file: string, rootDir: string): string;

export function collectSitePaths(packageRoot: string): string[];

export function isSitemapPath(sitePath: string): boolean;

export function absoluteSiteUrl(sitePath: string): string;

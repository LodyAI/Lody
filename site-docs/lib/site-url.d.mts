export const SITE_URL: string;
export const APP_OWNED_PATHS: readonly string[];
export function pageHref(href: string): string;
export function isAppOwnedHref(href: string | undefined): boolean;
export function appOwnedRel(href: string | undefined, rel?: string): string | undefined;
export function isSitePageHref(href: string): boolean;
export function siteHref(href: string): string;
export function absoluteSiteUrl(href: string): string;
export function absolutePageUrl(href: string): string;

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export { SITE_URL, absoluteSiteUrl } from '../lib/site-url.mjs';

export const SITE_LOCALES = ['en', 'zh', 'zh-hant', 'ja', 'ko', 'es', 'fr', 'ru'];

export function localePrefix(locale) {
  return locale === 'en' ? '' : `/${locale}`;
}

const BASE_STATIC_PATHS = [
  '/',
  '/home',
  '/docs',
  '/price',
  '/blog',
  '/changelog',
  '/download',
  '/download/nightly',
  '/privacy',
  '/terms',
  '/support',
  '/account-deletion',
  '/404',
];

function localizePath(enPath, locale) {
  const prefix = localePrefix(locale);
  if (!prefix) return enPath;
  return enPath === '/' ? prefix : `${prefix}${enPath}`;
}

const STATIC_PATHS = SITE_LOCALES.flatMap((locale) =>
  BASE_STATIC_PATHS.map((enPath) => localizePath(enPath, locale))
);

const SITEMAP_EXCLUDED_PATHS = new Set(
  SITE_LOCALES.flatMap((locale) => [localizePath('/home', locale), localizePath('/404', locale)])
);

export function isSitemapPath(sitePath) {
  return !SITEMAP_EXCLUDED_PATHS.has(sitePath);
}

function exists(p) {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

function listMdxFiles(dir) {
  if (!exists(dir)) return [];

  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listMdxFiles(entryPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.mdx')) {
      files.push(entryPath);
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function hasDraftFrontmatter(file) {
  const source = readFileSync(file, 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(source);
  return match ? /^draft:\s*true\s*$/imu.test(match[1]) : false;
}

export function slugFromMdxFile(file, rootDir) {
  const relative = path.relative(rootDir, file).replace(/\\/gu, '/');
  const segments = relative.replace(/\.mdx$/u, '').split('/');
  const page = segments.pop();
  const routeSegments = segments.filter((segment) => !/^\(.+\)$/u.test(segment));

  if (page && page !== 'index') {
    routeSegments.push(page);
  }

  return routeSegments.join('/');
}

function docsPaths(packageRoot, locale) {
  const dir = path.join(packageRoot, 'content', 'docs', locale);
  const base = localizePath('/docs', locale);

  return listMdxFiles(dir)
    .filter((file) => !hasDraftFrontmatter(file))
    .map((file) => {
      const slug = slugFromMdxFile(file, dir);
      return slug.length === 0 ? base : `${base}/${slug}`;
    });
}

function collectionPaths(packageRoot, collection, locale) {
  const dir = path.join(packageRoot, 'content', collection, locale);
  const base = localizePath(`/${collection}`, locale);

  return listMdxFiles(dir)
    .filter((file) => !hasDraftFrontmatter(file))
    .map((file) => {
      const slug = slugFromMdxFile(file, dir);
      return slug.length === 0 ? base : `${base}/${slug}`;
    });
}

export function collectSitePaths(packageRoot) {
  const paths = [
    ...STATIC_PATHS,
    ...SITE_LOCALES.flatMap((locale) => docsPaths(packageRoot, locale)),
    ...SITE_LOCALES.flatMap((locale) => collectionPaths(packageRoot, 'blog', locale)),
    ...SITE_LOCALES.flatMap((locale) => collectionPaths(packageRoot, 'changelog', locale)),
  ];

  return Array.from(new Set(paths)).sort((a, b) => a.localeCompare(b));
}

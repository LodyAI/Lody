import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export const SITE_URL = 'https://lody.ai';

const STATIC_PATHS = [
  '/',
  '/home',
  '/zh',
  '/zh/home',
  '/docs',
  '/zh/docs',
  '/price',
  '/zh/price',
  '/blog',
  '/zh/blog',
  '/changelog',
  '/zh/changelog',
  '/download',
  '/zh/download',
  '/privacy',
  '/zh/privacy',
  '/terms',
  '/zh/terms',
  '/support',
  '/zh/support',
  '/account-deletion',
  '/zh/account-deletion',
  '/404',
  '/zh/404',
];

const SITEMAP_EXCLUDED_PATHS = new Set(['/home', '/zh/home', '/404', '/zh/404']);

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
  const base = locale === 'zh' ? '/zh/docs' : '/docs';

  return listMdxFiles(dir)
    .filter((file) => !hasDraftFrontmatter(file))
    .map((file) => {
      const slug = slugFromMdxFile(file, dir);
      return slug.length === 0 ? base : `${base}/${slug}`;
    });
}

function collectionPaths(packageRoot, collection, locale) {
  const dir = path.join(packageRoot, 'content', collection, locale);
  const base = locale === 'zh' ? `/zh/${collection}` : `/${collection}`;

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
    ...docsPaths(packageRoot, 'en'),
    ...docsPaths(packageRoot, 'zh'),
    ...collectionPaths(packageRoot, 'blog', 'en'),
    ...collectionPaths(packageRoot, 'blog', 'zh'),
    ...collectionPaths(packageRoot, 'changelog', 'en'),
    ...collectionPaths(packageRoot, 'changelog', 'zh'),
  ];

  return Array.from(new Set(paths)).sort((a, b) => a.localeCompare(b));
}

export function absoluteSiteUrl(sitePath) {
  const url = new URL(sitePath, SITE_URL);
  if (url.pathname !== '/' && !url.pathname.endsWith('/') && !/\.[^/]+$/u.test(url.pathname)) {
    url.pathname += '/';
  }
  return url.toString();
}

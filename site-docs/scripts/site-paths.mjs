import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export { SITE_URL, absoluteSiteUrl } from '../lib/site-url.mjs';

export const SITE_LOCALES = ['en', 'zh', 'zh-hant', 'ja', 'ko', 'es', 'fr', 'ru'];

export function localePrefix(locale) {
  return locale === 'en' ? '' : `/${locale}`;
}

const PREFIXED_LOCALES = SITE_LOCALES.filter((locale) => locale !== 'en').sort(
  (a, b) => localePrefix(b).length - localePrefix(a).length
);

export function detectPathLocale(sitePath) {
  for (const locale of PREFIXED_LOCALES) {
    const prefix = localePrefix(locale);
    if (sitePath === prefix || sitePath.startsWith(`${prefix}/`)) {
      return locale;
    }
  }
  return 'en';
}

export function stripLocalePrefix(sitePath) {
  const locale = detectPathLocale(sitePath);
  const prefix = localePrefix(locale);
  const rest = prefix ? sitePath.slice(prefix.length) : sitePath;
  return { locale, basePath: rest.length === 0 ? '/' : rest };
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

const STATIC_ROUTE_SOURCES = {
  '/': [
    'lib/landing-seo.ts',
    'components/landing-copy.ts',
    'components/landing.tsx',
    'components/landing-feature-tabs.tsx',
    'components/landing-power-i18n.ts',
    'components/landing-preview-data.ts',
    'src/site-pages/landing.tsx',
  ],
  '/price': [
    'src/site-pages/pricing.tsx',
    'components/pricing-copy.ts',
    'components/pricing-page.tsx',
  ],
  '/download': ['src/site-pages/download.tsx', 'components/download-page.tsx'],
  '/download/nightly': [
    'src/site-pages/download.tsx',
    'components/nightly-download-page.tsx',
    'components/nightly-downloads.tsx',
  ],
  '/blog': ['src/site-pages/blog.tsx', 'components/blog.tsx'],
  '/changelog': ['src/site-pages/changelog.tsx', 'components/changelog.tsx'],
};

const LEGAL_PAGE_SLUGS = new Set(['privacy', 'terms', 'support', 'account-deletion']);

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

function toPosixRelative(packageRoot, file) {
  return path.relative(packageRoot, file).replace(/\\/gu, '/');
}

function docsEntries(packageRoot, locale) {
  const dir = path.join(packageRoot, 'content', 'docs', locale);
  const base = localizePath('/docs', locale);

  return listMdxFiles(dir)
    .filter((file) => !hasDraftFrontmatter(file))
    .map((file) => {
      const slug = slugFromMdxFile(file, dir);
      return {
        path: slug.length === 0 ? base : `${base}/${slug}`,
        source: toPosixRelative(packageRoot, file),
      };
    });
}

function collectionEntries(packageRoot, collection, locale) {
  const dir = path.join(packageRoot, 'content', collection, locale);
  const base = localizePath(`/${collection}`, locale);

  return listMdxFiles(dir)
    .filter((file) => !hasDraftFrontmatter(file))
    .map((file) => {
      const slug = slugFromMdxFile(file, dir);
      return {
        path: slug.length === 0 ? base : `${base}/${slug}`,
        source: toPosixRelative(packageRoot, file),
      };
    });
}

export function collectSitePathSources(packageRoot) {
  const sourcesByPath = new Map();
  const addSources = (sitePath, sources) => {
    const existing = sourcesByPath.get(sitePath);
    if (!existing) {
      sourcesByPath.set(sitePath, [...sources]);
      return;
    }
    for (const source of sources) {
      if (!existing.includes(source)) existing.push(source);
    }
  };

  for (const locale of SITE_LOCALES) {
    const docs = docsEntries(packageRoot, locale);
    for (const entry of docs) addSources(entry.path, [entry.source]);

    const blog = collectionEntries(packageRoot, 'blog', locale);
    for (const entry of blog) addSources(entry.path, [entry.source]);

    const changelog = collectionEntries(packageRoot, 'changelog', locale);
    for (const entry of changelog) addSources(entry.path, [entry.source]);

    for (const basePath of BASE_STATIC_PATHS) {
      const localized = localizePath(basePath, locale);
      if (basePath === '/home' || basePath === '/404') continue;
      if (basePath === '/docs') {
        if (!sourcesByPath.has(localized)) addSources(localized, []);
        continue;
      }

      const legalSlug = basePath.slice(1);
      if (LEGAL_PAGE_SLUGS.has(legalSlug)) {
        const legalFile = path.join(packageRoot, 'content', 'pages', locale, `${legalSlug}.mdx`);
        addSources(localized, exists(legalFile) ? [toPosixRelative(packageRoot, legalFile)] : []);
        continue;
      }

      const staticSources = STATIC_ROUTE_SOURCES[basePath] ?? [];
      if (basePath === '/blog') {
        addSources(localized, [...staticSources, ...blog.map((entry) => entry.source)]);
      } else if (basePath === '/changelog') {
        addSources(localized, [...staticSources, ...changelog.map((entry) => entry.source)]);
      } else {
        addSources(localized, staticSources);
      }
    }
  }

  return sourcesByPath;
}

export function collectSitePaths(packageRoot) {
  const paths = [
    ...STATIC_PATHS,
    ...SITE_LOCALES.flatMap((locale) => docsEntries(packageRoot, locale).map((e) => e.path)),
    ...SITE_LOCALES.flatMap((locale) =>
      collectionEntries(packageRoot, 'blog', locale).map((e) => e.path)
    ),
    ...SITE_LOCALES.flatMap((locale) =>
      collectionEntries(packageRoot, 'changelog', locale).map((e) => e.path)
    ),
  ];

  return Array.from(new Set(paths)).sort((a, b) => a.localeCompare(b));
}

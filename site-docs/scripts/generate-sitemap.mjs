import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { absolutePageUrl, absoluteSiteUrl } from '../lib/site-url.mjs';
import {
  collectSitePaths,
  collectSitePathSources,
  detectPathLocale,
  isSitemapPath,
  SITE_LOCALES,
} from './site-paths.mjs';

const SITEMAP_NS = 'http://www.sitemaps.org/schemas/sitemap/0.9';
const ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;
const COMMIT_MARKER = '__COMMIT__';

export function sitemapFilenameForLocale(locale) {
  return `sitemap-${locale}.xml`;
}

export function normalizeLastmodDate(value) {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString().slice(0, 10) : undefined;
  }
  const text = String(value).trim();
  if (!text) return undefined;
  if (ISO_DATE_ONLY.test(text)) {
    const parsed = new Date(`${text}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text
      ? text
      : undefined;
  }
  const parsed = new Date(text);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : undefined;
}

export function maxIsoDate(dates) {
  let latest;
  for (const candidate of dates) {
    if (!candidate) continue;
    if (!latest || candidate > latest) latest = candidate;
  }
  return latest;
}

export function parseGitLastmodLog(output, shallowBoundaries = new Set()) {
  const lastmodByFile = new Map();
  let currentDate;

  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith(COMMIT_MARKER)) {
      const payload = line.slice(COMMIT_MARKER.length);
      const tabIndex = payload.indexOf('\t');
      if (tabIndex === -1) {
        currentDate = normalizeLastmodDate(payload);
      } else {
        const sha = payload.slice(0, tabIndex).trim();
        const dateRaw = payload.slice(tabIndex + 1).trim();
        currentDate = shallowBoundaries.has(sha) ? undefined : normalizeLastmodDate(dateRaw);
      }
      continue;
    }
    if (!currentDate) continue;
    const normalizedPath = line.replace(/\\/gu, '/');
    if (!lastmodByFile.has(normalizedPath)) {
      lastmodByFile.set(normalizedPath, currentDate);
    }
  }

  return lastmodByFile;
}

export function readShallowBoundaryCommits(packageRoot) {
  try {
    const shallowRaw = execFileSync('git', ['rev-parse', '--git-path', 'shallow'], {
      cwd: packageRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!shallowRaw) return new Set();
    const shallowPath = path.resolve(packageRoot, shallowRaw);
    if (!existsSync(shallowPath)) return new Set();
    return new Set(
      readFileSync(shallowPath, 'utf8')
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => /^[0-9a-f]{40,64}$/iu.test(line))
    );
  } catch {
    return new Set();
  }
}

/**
 * Collect the latest git commit date (UTC YYYY-MM-DD) for each tracked file
 * under `packageRoot`. Skips shallow boundary commits (listed in `.git/shallow`)
 * because git diffs a grafted boundary commit against an empty tree, which
 * would otherwise attribute the boundary date to every untouched file.
 */
export function collectGitLastmodByFile(packageRoot) {
  try {
    const shallowBoundaries = readShallowBoundaryCommits(packageRoot);
    const logOutput = execFileSync(
      'git',
      [
        '-c',
        'core.quotepath=false',
        'log',
        '--relative',
        `--format=${COMMIT_MARKER}%H\t%cI`,
        '--name-only',
        '--',
        '.',
      ],
      {
        cwd: packageRoot,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    );
    return parseGitLastmodLog(logOutput, shallowBoundaries);
  } catch {
    return new Map();
  }
}

export function readMdxFrontmatterLastmod(filePath) {
  if (!filePath.endsWith('.mdx') || !existsSync(filePath)) return undefined;
  try {
    const source = readFileSync(filePath, 'utf8');
    const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(source);
    if (!match) return undefined;
    const frontmatter = parseYaml(match[1]);
    if (!frontmatter || typeof frontmatter !== 'object') return undefined;
    return maxIsoDate([
      normalizeLastmodDate(frontmatter.updated),
      normalizeLastmodDate(frontmatter.lastModified),
      normalizeLastmodDate(frontmatter.dateModified),
      normalizeLastmodDate(frontmatter.date),
    ]);
  } catch {
    return undefined;
  }
}

function escapeXml(value) {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;');
}

function renderUrlset(entries) {
  const body = entries
    .map(({ loc, lastmod }) =>
      lastmod
        ? `  <url><loc>${escapeXml(loc)}</loc><lastmod>${lastmod}</lastmod></url>`
        : `  <url><loc>${escapeXml(loc)}</loc></url>`
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="${SITEMAP_NS}">\n${body}\n</urlset>\n`;
}

function renderSitemapIndex(sitemaps) {
  const body = sitemaps
    .map(({ loc, lastmod }) =>
      lastmod
        ? `  <sitemap><loc>${escapeXml(loc)}</loc><lastmod>${lastmod}</lastmod></sitemap>`
        : `  <sitemap><loc>${escapeXml(loc)}</loc></sitemap>`
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="${SITEMAP_NS}">\n${body}\n</sitemapindex>\n`;
}

export function generateSitemaps(packageRoot, options = {}) {
  const publicDir = options.publicDir ?? path.join(packageRoot, 'public');
  const gitLastmodByFile = options.gitLastmodByFile ?? collectGitLastmodByFile(packageRoot);
  const sourcesByPath = collectSitePathSources(packageRoot);
  const frontmatterDateCache = new Map();

  const fileLastmod = (relativeSource) => {
    const gitDate = gitLastmodByFile.get(relativeSource);
    let fmDate;
    if (relativeSource.endsWith('.mdx')) {
      if (!frontmatterDateCache.has(relativeSource)) {
        frontmatterDateCache.set(
          relativeSource,
          readMdxFrontmatterLastmod(path.join(packageRoot, relativeSource))
        );
      }
      fmDate = frontmatterDateCache.get(relativeSource);
    }
    return maxIsoDate([gitDate, fmDate]);
  };

  const pathsByLocale = new Map(SITE_LOCALES.map((locale) => [locale, []]));
  for (const sitePath of collectSitePaths(packageRoot).filter(isSitemapPath)) {
    const locale = detectPathLocale(sitePath);
    pathsByLocale.get(locale).push(sitePath);
  }

  mkdirSync(publicDir, { recursive: true });

  const indexEntries = [];
  let totalUrls = 0;

  for (const locale of SITE_LOCALES) {
    const localePaths = pathsByLocale.get(locale) ?? [];
    const urlEntries = localePaths.map((sitePath) => {
      const sources = sourcesByPath.get(sitePath) ?? [];
      const lastmod = maxIsoDate(sources.map(fileLastmod));
      return {
        path: sitePath,
        loc: absolutePageUrl(sitePath),
        lastmod,
      };
    });

    const filename = sitemapFilenameForLocale(locale);
    writeFileSync(path.join(publicDir, filename), renderUrlset(urlEntries), 'utf8');

    indexEntries.push({
      locale,
      filename,
      loc: absoluteSiteUrl(`/${filename}`),
      lastmod: maxIsoDate(urlEntries.map((entry) => entry.lastmod)),
      count: urlEntries.length,
    });
    totalUrls += urlEntries.length;
  }

  writeFileSync(path.join(publicDir, 'sitemap.xml'), renderSitemapIndex(indexEntries), 'utf8');

  return { indexEntries, totalUrls };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { indexEntries, totalUrls } = generateSitemaps(packageRoot);
  process.stdout.write(
    `Generated public/sitemap.xml and ${indexEntries.length} locale sitemaps (${totalUrls} URLs)\n`
  );
}

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { absoluteSiteUrl, collectSitePaths, isSitemapPath } from './site-paths.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sitemapPath = path.join(packageRoot, 'public', 'sitemap.xml');

const entries = collectSitePaths(packageRoot)
  .filter(isSitemapPath)
  .map((sitePath) => `  <url><loc>${absoluteSiteUrl(sitePath)}</loc></url>`)
  .join('\n');

const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;

mkdirSync(path.dirname(sitemapPath), { recursive: true });
writeFileSync(sitemapPath, xml, 'utf8');

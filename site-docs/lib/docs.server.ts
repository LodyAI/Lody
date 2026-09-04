import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DocsRouteData, SiteLocale } from '@site/src/site-pages/shared';
import { notFound } from '@tanstack/react-router';
import { renderToString } from 'react-dom/server.edge';
import { extractFaqFromMdx } from './docs-faq';
import { sourceEn, sourceZh } from './source';

const contentDocsRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'content',
  'docs'
);

function findDocMdx(locale: SiteLocale, slug?: string[]): string | undefined {
  const leaf = slug?.[slug.length - 1];
  if (!leaf) return undefined;

  const stack = [path.join(contentDocsRoot, locale)];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.name === `${leaf}.mdx`) {
        return entryPath;
      }
    }
  }

  return undefined;
}

function loadDocsFaq(locale: SiteLocale, slug?: string[]) {
  const file = findDocMdx(locale, slug);
  if (!file) return undefined;
  const items = extractFaqFromMdx(readFileSync(file, 'utf8'));
  return items.length > 0 ? items : undefined;
}

function slugFromSplat(splat: string | undefined): string[] | undefined {
  const segments = splat?.split('/').filter((segment) => segment.length > 0) ?? [];
  return segments.length > 0 ? segments : undefined;
}

function docsPath(locale: SiteLocale, slug?: string[]) {
  const basePath = locale === 'zh' ? '/zh/docs' : '/docs';
  return slug && slug.length > 0 ? `${basePath}/${slug.join('/')}` : basePath;
}

function getDocsSource(locale: SiteLocale) {
  return locale === 'zh' ? sourceZh : sourceEn;
}

export async function loadDocsRouteData(
  locale: SiteLocale,
  splat: string | undefined
): Promise<DocsRouteData> {
  const slug = slugFromSplat(splat);
  const source = getDocsSource(locale);
  const page = source.getPage(slug);
  if (!page) throw notFound();

  return {
    title: page.data.title,
    description: page.data.description,
    path: docsPath(locale, slug),
    docPath: page.path,
    pageTree: await source.serializePageTree(source.getPageTree()),
    toc: page.data.toc.map((item) => ({
      ...item,
      title: renderToString(item.title),
    })),
    slug,
    faq: loadDocsFaq(locale, slug),
  };
}

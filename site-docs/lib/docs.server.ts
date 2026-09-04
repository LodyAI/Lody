import type { DocsRouteData, SiteLocale } from '@site/src/site-pages/shared';
import { notFound } from '@tanstack/react-router';
import { renderToString } from 'react-dom/server.edge';
import { sourceEn, sourceZh } from './source';

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
  };
}

import { DocsTocLanguageSelect } from '@site/components/docs-toc-language-select';
import { DocsSidebarFooter } from '@site/components/docs-sidebar-footer';
import { getMDXComponents } from '@site/components/mdx';
import { baseOptions } from '@site/lib/layout.shared';
import { docsFaqForPath } from '@site/lib/docs-faq';
import { faqJsonLd } from '@site/lib/json-ld';
import { brandTitle, pageHead } from '@site/lib/metadata';
import type { SiteHead } from '@site/lib/metadata';
import browserCollections from '@site/.source/browser';
import { deserializePageTree } from 'fumadocs-core/source/client';
import type { TOCItemType } from 'fumadocs-core/toc';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/layouts/docs/page';
import { type DocsRouteData, localeCode, type SerializedTocItem, type SiteLocale } from './shared';

const docsContentLoaders = {
  en: browserCollections.docsEn.createClientLoader({
    id: 'docsEn',
    component({ default: MDX }) {
      return <MDX components={getMDXComponents()} />;
    },
  }),
  zh: browserCollections.docsZh.createClientLoader({
    id: 'docsZh',
    component({ default: MDX }) {
      return <MDX components={getMDXComponents()} />;
    },
  }),
};

export function docsHead(locale: SiteLocale, data: DocsRouteData): SiteHead {
  const enPath = locale === 'zh' ? data.path.replace(/^\/zh/u, '') || '/docs' : data.path;
  const zhPath = enPath === '/docs' ? '/zh/docs' : `/zh${enPath}`;

  return pageHead({
    title: brandTitle(data.title),
    description: data.description,
    path: data.path,
    locale: localeCode(locale),
    alternates: [
      { lang: 'en-US', path: enPath },
      { lang: 'zh-CN', path: zhPath },
    ],
    jsonLd: faqJsonLd(docsFaqForPath(data.path)),
  });
}

export async function preloadDocsContent(locale: SiteLocale, docPath: string) {
  await docsContentLoaders[locale].preload(docPath);
}

function deserializeToc(toc: SerializedTocItem[]): TOCItemType[] {
  return toc.map((item) => ({
    ...item,
    title: <span dangerouslySetInnerHTML={{ __html: item.title }} />,
  }));
}

export function DocsRoutePage({ locale, data }: { locale: SiteLocale; data: DocsRouteData }) {
  return (
    <DocsLayout
      {...baseOptions(locale)}
      tree={deserializePageTree(data.pageTree)}
      sidebar={{
        defaultOpenLevel: 1,
        footer: <DocsSidebarFooter />,
      }}
    >
      <DocsPage
        toc={deserializeToc(data.toc)}
        tableOfContent={{
          header: <DocsTocLanguageSelect />,
        }}
        tableOfContentPopover={{
          header: <DocsTocLanguageSelect />,
        }}
      >
        <DocsTitle>{data.title}</DocsTitle>
        <DocsDescription>{data.description}</DocsDescription>
        <DocsBody>{docsContentLoaders[locale].useContent(data.docPath)}</DocsBody>
      </DocsPage>
    </DocsLayout>
  );
}

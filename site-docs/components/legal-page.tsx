import '@site/app/legal.css';
import { getMDXComponents } from '@site/components/mdx';
import { SiteNav } from '@site/components/site-nav';
import type { LegalPageEntry, PageLocale } from '@site/lib/pages';
import browserCollections from '@site/.source/browser';
import type { SiteLocale } from '@site/src/site-pages/shared';

const pageContentLoaders: Record<
  SiteLocale,
  ReturnType<typeof browserCollections.pagesEn.createClientLoader>
> = {
  en: browserCollections.pagesEn.createClientLoader({
    id: 'pagesEn',
    component({ default: MDX }) {
      return <MDX components={getMDXComponents()} />;
    },
  }),
  zh: browserCollections.pagesZh.createClientLoader({
    id: 'pagesZh',
    component({ default: MDX }) {
      return <MDX components={getMDXComponents()} />;
    },
  }),
  'zh-hant': browserCollections.pagesZhHant.createClientLoader({
    id: 'pagesZhHant',
    component({ default: MDX }) {
      return <MDX components={getMDXComponents()} />;
    },
  }),
  ja: browserCollections.pagesJa.createClientLoader({
    id: 'pagesJa',
    component({ default: MDX }) {
      return <MDX components={getMDXComponents()} />;
    },
  }),
  ko: browserCollections.pagesKo.createClientLoader({
    id: 'pagesKo',
    component({ default: MDX }) {
      return <MDX components={getMDXComponents()} />;
    },
  }),
  es: browserCollections.pagesEs.createClientLoader({
    id: 'pagesEs',
    component({ default: MDX }) {
      return <MDX components={getMDXComponents()} />;
    },
  }),
  fr: browserCollections.pagesFr.createClientLoader({
    id: 'pagesFr',
    component({ default: MDX }) {
      return <MDX components={getMDXComponents()} />;
    },
  }),
  ru: browserCollections.pagesRu.createClientLoader({
    id: 'pagesRu',
    component({ default: MDX }) {
      return <MDX components={getMDXComponents()} />;
    },
  }),
};

export async function preloadLegalPageContent(locale: PageLocale, docPath: string) {
  await pageContentLoaders[locale].preload(docPath);
}

export function LegalPage({ entry, locale }: { entry: LegalPageEntry; locale: PageLocale }) {
  return (
    <div className="landing-page-root legal-page-root">
      <SiteNav locale={locale} />
      <main className="legal-page">
        <article className="legal-page__article max-w-3xl">
          <header className="legal-page__header">
            <h1>{entry.title}</h1>
            {entry.description ? <p className="legal-page__lead">{entry.description}</p> : null}
          </header>
          <div className="legal-page__body">
            {pageContentLoaders[locale].useContent(entry.docPath)}
          </div>
        </article>
      </main>
    </div>
  );
}

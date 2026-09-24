import '@site/app/legal.css';
import { getMDXComponents } from '@site/components/mdx';
import { SiteNav } from '@site/components/site-nav';
import type { LegalPageEntry, PageLocale } from '@site/lib/pages';
import browserCollections from '@site/.source/browser';

const pageContentLoaders = {
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
};

export async function preloadLegalPageContent(locale: PageLocale, docPath: string) {
  await pageContentLoaders[locale].preload(docPath);
}

export function LegalPage({ entry, locale }: { entry: LegalPageEntry; locale: PageLocale }) {
  const languageHref = locale === 'zh' ? `/${entry.slug}` : `/zh/${entry.slug}`;

  return (
    <div className="landing-page-root legal-page-root">
      <SiteNav locale={locale} languageHref={languageHref} />
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

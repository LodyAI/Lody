import { notFoundHead } from '@site/lib/not-found-seo';
import { loadDocsRoute } from '@site/src/docs-loader';
import { DocsRoutePage, docsHead, preloadDocsContent } from '@site/src/site-pages/docs';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/ko/docs/$')({
  loader: async ({ params }) => {
    const data = await loadDocsRoute({ data: { locale: 'ko', splat: params._splat } });
    await preloadDocsContent('ko', data.docPath);

    return data;
  },
  head: ({ loaderData }) => (loaderData ? docsHead('ko', loaderData) : notFoundHead('ko')),
  component: Docs,
});

function Docs() {
  const data = Route.useLoaderData();

  return <DocsRoutePage locale="ko" data={data} />;
}

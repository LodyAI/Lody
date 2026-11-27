import { notFoundHead } from '@site/lib/not-found-seo';
import { loadDocsRoute } from '@site/src/docs-loader';
import { DocsRoutePage, docsHead, preloadDocsContent } from '@site/src/site-pages/docs';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/ja/docs/$')({
  loader: async ({ params }) => {
    const data = await loadDocsRoute({ data: { locale: 'ja', splat: params._splat } });
    await preloadDocsContent('ja', data.docPath);

    return data;
  },
  head: ({ loaderData }) => (loaderData ? docsHead('ja', loaderData) : notFoundHead('ja')),
  component: Docs,
});

function Docs() {
  const data = Route.useLoaderData();

  return <DocsRoutePage locale="ja" data={data} />;
}

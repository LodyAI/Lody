import { notFoundHead } from '@site/lib/not-found-seo';
import { loadDocsRoute } from '@site/src/docs-loader';
import { DocsRoutePage, docsHead, preloadDocsContent } from '@site/src/site-pages/docs';
import { createFileRoute } from '@tanstack/react-router';
export const Route = createFileRoute('/docs/$')({
  loader: async ({ params }) => {
    const data = await loadDocsRoute({ data: { locale: 'en', splat: params._splat } });
    await preloadDocsContent('en', data.docPath);

    return data;
  },
  head: ({ loaderData }) => (loaderData ? docsHead('en', loaderData) : notFoundHead('en')),
  component: Docs,
});

function Docs() {
  const data = Route.useLoaderData();

  return <DocsRoutePage locale="en" data={data} />;
}

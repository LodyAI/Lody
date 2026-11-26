import { notFoundHead } from '@site/lib/not-found-seo';
import { loadDocsRoute } from '@site/src/docs-loader';
import { DocsRoutePage, docsHead, preloadDocsContent } from '@site/src/site-pages/docs';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/fr/docs/$')({
  loader: async ({ params }) => {
    const data = await loadDocsRoute({ data: { locale: 'fr', splat: params._splat } });
    await preloadDocsContent('fr', data.docPath);

    return data;
  },
  head: ({ loaderData }) => (loaderData ? docsHead('fr', loaderData) : notFoundHead('fr')),
  component: Docs,
});

function Docs() {
  const data = Route.useLoaderData();

  return <DocsRoutePage locale="fr" data={data} />;
}

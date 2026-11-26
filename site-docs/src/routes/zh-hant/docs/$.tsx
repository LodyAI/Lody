import { notFoundHead } from '@site/lib/not-found-seo';
import { loadDocsRoute } from '@site/src/docs-loader';
import { DocsRoutePage, docsHead, preloadDocsContent } from '@site/src/site-pages/docs';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/zh-hant/docs/$')({
  loader: async ({ params }) => {
    const data = await loadDocsRoute({ data: { locale: 'zh-hant', splat: params._splat } });
    await preloadDocsContent('zh-hant', data.docPath);

    return data;
  },
  head: ({ loaderData }) =>
    loaderData ? docsHead('zh-hant', loaderData) : notFoundHead('zh-hant'),
  component: Docs,
});

function Docs() {
  const data = Route.useLoaderData();

  return <DocsRoutePage locale="zh-hant" data={data} />;
}

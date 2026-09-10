import { preloadChangelogContent } from '@site/components/changelog';
import { notFoundHead } from '@site/lib/not-found-seo';
import { loadChangelogPostRoute } from '@site/src/changelog-loader';
import { ChangelogPostRoutePage, changelogPostHead } from '@site/src/site-pages/changelog';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/zh/changelog/$slug')({
  loader: async ({ params }) => {
    const data = await loadChangelogPostRoute({ data: { locale: 'zh', slug: params.slug } });
    await preloadChangelogContent('zh', data.entry.docPath);

    return data;
  },
  head: ({ loaderData }) => (loaderData ? changelogPostHead('zh', loaderData) : notFoundHead('zh')),
  component: ChangelogPost,
});

function ChangelogPost() {
  const data = Route.useLoaderData();

  return <ChangelogPostRoutePage data={data} locale="zh" />;
}

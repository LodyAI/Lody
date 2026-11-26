import { preloadChangelogContent } from '@site/components/changelog';
import { notFoundHead } from '@site/lib/not-found-seo';
import { loadChangelogPostRoute } from '@site/src/changelog-loader';
import { ChangelogPostRoutePage, changelogPostHead } from '@site/src/site-pages/changelog';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/ru/changelog/$slug')({
  loader: async ({ params }) => {
    const data = await loadChangelogPostRoute({ data: { locale: 'ru', slug: params.slug } });
    await preloadChangelogContent('ru', data.entry.docPath);

    return data;
  },
  head: ({ loaderData }) => (loaderData ? changelogPostHead('ru', loaderData) : notFoundHead('ru')),
  component: ChangelogPost,
});

function ChangelogPost() {
  const data = Route.useLoaderData();

  return <ChangelogPostRoutePage data={data} locale="ru" />;
}

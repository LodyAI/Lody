import { preloadChangelogContent } from '@site/components/changelog';
import { notFoundHead } from '@site/lib/not-found-seo';
import { loadChangelogPostRoute } from '@site/src/changelog-loader';
import { ChangelogPostRoutePage, changelogPostHead } from '@site/src/site-pages/changelog';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/fr/changelog/$slug')({
  loader: async ({ params }) => {
    const data = await loadChangelogPostRoute({ data: { locale: 'fr', slug: params.slug } });
    await preloadChangelogContent('fr', data.entry.docPath);

    return data;
  },
  head: ({ loaderData }) => (loaderData ? changelogPostHead('fr', loaderData) : notFoundHead('fr')),
  component: ChangelogPost,
});

function ChangelogPost() {
  const data = Route.useLoaderData();

  return <ChangelogPostRoutePage data={data} locale="fr" />;
}

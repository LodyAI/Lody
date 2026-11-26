import { preloadChangelogContents } from '@site/components/changelog';
import { loadChangelogIndexRoute } from '@site/src/changelog-loader';
import { ChangelogIndexRoutePage, changelogIndexHead } from '@site/src/site-pages/changelog';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/fr/changelog/')({
  loader: async () => {
    const entries = await loadChangelogIndexRoute({ data: { locale: 'fr' } });
    await preloadChangelogContents(
      'fr',
      entries.map((entry) => entry.docPath)
    );

    return entries;
  },
  head: () => changelogIndexHead('fr'),
  component: ChangelogIndex,
});

function ChangelogIndex() {
  const entries = Route.useLoaderData();

  return <ChangelogIndexRoutePage entries={entries} locale="fr" />;
}

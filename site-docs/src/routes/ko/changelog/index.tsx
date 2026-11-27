import { preloadChangelogContents } from '@site/components/changelog';
import { loadChangelogIndexRoute } from '@site/src/changelog-loader';
import { ChangelogIndexRoutePage, changelogIndexHead } from '@site/src/site-pages/changelog';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/ko/changelog/')({
  loader: async () => {
    const entries = await loadChangelogIndexRoute({ data: { locale: 'ko' } });
    await preloadChangelogContents(
      'ko',
      entries.map((entry) => entry.docPath)
    );

    return entries;
  },
  head: () => changelogIndexHead('ko'),
  component: ChangelogIndex,
});

function ChangelogIndex() {
  const entries = Route.useLoaderData();

  return <ChangelogIndexRoutePage entries={entries} locale="ko" />;
}

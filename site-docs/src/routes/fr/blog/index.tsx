import { BlogIndexRoutePage, blogIndexHead } from '@site/src/site-pages/blog';
import { loadBlogIndexRoute } from '@site/src/blog-loader';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/fr/blog/')({
  loader: () => loadBlogIndexRoute({ data: { locale: 'fr' } }),
  head: ({ loaderData }) => blogIndexHead('fr', loaderData),
  component: BlogIndex,
});

function BlogIndex() {
  const entries = Route.useLoaderData();

  return <BlogIndexRoutePage entries={entries} locale="fr" />;
}

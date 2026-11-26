import { BlogIndexRoutePage, blogIndexHead } from '@site/src/site-pages/blog';
import { loadBlogIndexRoute } from '@site/src/blog-loader';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/ja/blog/')({
  loader: () => loadBlogIndexRoute({ data: { locale: 'ja' } }),
  head: ({ loaderData }) => blogIndexHead('ja', loaderData),
  component: BlogIndex,
});

function BlogIndex() {
  const entries = Route.useLoaderData();

  return <BlogIndexRoutePage entries={entries} locale="ja" />;
}

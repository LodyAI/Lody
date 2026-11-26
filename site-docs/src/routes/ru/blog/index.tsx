import { BlogIndexRoutePage, blogIndexHead } from '@site/src/site-pages/blog';
import { loadBlogIndexRoute } from '@site/src/blog-loader';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/ru/blog/')({
  loader: () => loadBlogIndexRoute({ data: { locale: 'ru' } }),
  head: ({ loaderData }) => blogIndexHead('ru', loaderData),
  component: BlogIndex,
});

function BlogIndex() {
  const entries = Route.useLoaderData();

  return <BlogIndexRoutePage entries={entries} locale="ru" />;
}

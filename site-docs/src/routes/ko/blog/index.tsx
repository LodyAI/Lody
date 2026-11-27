import { BlogIndexRoutePage, blogIndexHead } from '@site/src/site-pages/blog';
import { loadBlogIndexRoute } from '@site/src/blog-loader';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/ko/blog/')({
  loader: () => loadBlogIndexRoute({ data: { locale: 'ko' } }),
  head: ({ loaderData }) => blogIndexHead('ko', loaderData),
  component: BlogIndex,
});

function BlogIndex() {
  const entries = Route.useLoaderData();

  return <BlogIndexRoutePage entries={entries} locale="ko" />;
}

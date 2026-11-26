import { BlogIndexRoutePage, blogIndexHead } from '@site/src/site-pages/blog';
import { loadBlogIndexRoute } from '@site/src/blog-loader';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/zh-hant/blog/')({
  loader: () => loadBlogIndexRoute({ data: { locale: 'zh-hant' } }),
  head: ({ loaderData }) => blogIndexHead('zh-hant', loaderData),
  component: BlogIndex,
});

function BlogIndex() {
  const entries = Route.useLoaderData();

  return <BlogIndexRoutePage entries={entries} locale="zh-hant" />;
}

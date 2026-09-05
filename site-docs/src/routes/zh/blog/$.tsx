import { preloadBlogContent } from '@site/components/blog';
import { notFoundHead } from '@site/lib/not-found-seo';
import { loadBlogPostRoute } from '@site/src/blog-loader';
import { BlogPostRoutePage, blogPostHead } from '@site/src/site-pages/blog';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/zh/blog/$')({
  loader: async ({ params }) => {
    const data = await loadBlogPostRoute({ data: { locale: 'zh', splat: params._splat } });
    await preloadBlogContent('zh', data.entry.docPath);

    return data;
  },
  head: ({ loaderData }) =>
    loaderData ? blogPostHead('zh', loaderData.entry) : notFoundHead('zh'),
  component: BlogPost,
});

function BlogPost() {
  const data = Route.useLoaderData();

  return (
    <BlogPostRoutePage entry={data.entry} locale="zh" next={data.next} previous={data.previous} />
  );
}

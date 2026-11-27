import { preloadBlogContent } from '@site/components/blog';
import { notFoundHead } from '@site/lib/not-found-seo';
import { loadBlogPostRoute } from '@site/src/blog-loader';
import { BlogPostRoutePage, blogPostHead } from '@site/src/site-pages/blog';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/ja/blog/$')({
  loader: async ({ params }) => {
    const data = await loadBlogPostRoute({ data: { locale: 'ja', splat: params._splat } });
    await preloadBlogContent('ja', data.entry.docPath);

    return data;
  },
  head: ({ loaderData }) =>
    loaderData ? blogPostHead('ja', loaderData.entry) : notFoundHead('ja'),
  component: BlogPost,
});

function BlogPost() {
  const data = Route.useLoaderData();

  return (
    <BlogPostRoutePage entry={data.entry} locale="ja" next={data.next} previous={data.previous} />
  );
}

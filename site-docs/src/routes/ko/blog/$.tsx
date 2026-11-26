import { preloadBlogContent } from '@site/components/blog';
import { notFoundHead } from '@site/lib/not-found-seo';
import { loadBlogPostRoute } from '@site/src/blog-loader';
import { BlogPostRoutePage, blogPostHead } from '@site/src/site-pages/blog';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/ko/blog/$')({
  loader: async ({ params }) => {
    const data = await loadBlogPostRoute({ data: { locale: 'ko', splat: params._splat } });
    await preloadBlogContent('ko', data.entry.docPath);

    return data;
  },
  head: ({ loaderData }) =>
    loaderData ? blogPostHead('ko', loaderData.entry) : notFoundHead('ko'),
  component: BlogPost,
});

function BlogPost() {
  const data = Route.useLoaderData();

  return (
    <BlogPostRoutePage entry={data.entry} locale="ko" next={data.next} previous={data.previous} />
  );
}

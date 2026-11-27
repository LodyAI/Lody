import { preloadBlogContent } from '@site/components/blog';
import { notFoundHead } from '@site/lib/not-found-seo';
import { loadBlogPostRoute } from '@site/src/blog-loader';
import { BlogPostRoutePage, blogPostHead } from '@site/src/site-pages/blog';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/ru/blog/$')({
  loader: async ({ params }) => {
    const data = await loadBlogPostRoute({ data: { locale: 'ru', splat: params._splat } });
    await preloadBlogContent('ru', data.entry.docPath);

    return data;
  },
  head: ({ loaderData }) =>
    loaderData ? blogPostHead('ru', loaderData.entry) : notFoundHead('ru'),
  component: BlogPost,
});

function BlogPost() {
  const data = Route.useLoaderData();

  return (
    <BlogPostRoutePage entry={data.entry} locale="ru" next={data.next} previous={data.previous} />
  );
}

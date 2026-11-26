import { preloadBlogContent } from '@site/components/blog';
import { notFoundHead } from '@site/lib/not-found-seo';
import { loadBlogPostRoute } from '@site/src/blog-loader';
import { BlogPostRoutePage, blogPostHead } from '@site/src/site-pages/blog';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/fr/blog/$')({
  loader: async ({ params }) => {
    const data = await loadBlogPostRoute({ data: { locale: 'fr', splat: params._splat } });
    await preloadBlogContent('fr', data.entry.docPath);

    return data;
  },
  head: ({ loaderData }) =>
    loaderData ? blogPostHead('fr', loaderData.entry) : notFoundHead('fr'),
  component: BlogPost,
});

function BlogPost() {
  const data = Route.useLoaderData();

  return (
    <BlogPostRoutePage entry={data.entry} locale="fr" next={data.next} previous={data.previous} />
  );
}

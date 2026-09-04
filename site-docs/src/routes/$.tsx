import { localeFromPathname, notFoundHead } from '@site/lib/not-found-seo';
import { createFileRoute, notFound } from '@tanstack/react-router';

export const Route = createFileRoute('/$')({
  beforeLoad: () => {
    throw notFound();
  },
  head: ({ params }) => notFoundHead(localeFromPathname(`/${params._splat ?? ''}`)),
});

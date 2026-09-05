import { notFoundHead } from '@site/lib/not-found-seo';
import { NotFoundPage } from '@site/src/site-pages/not-found';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/404')({
  head: () => notFoundHead('en'),
  component: () => <NotFoundPage locale="en" />,
});

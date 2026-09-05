import { notFoundHead } from '@site/lib/not-found-seo';
import { NotFoundPage } from '@site/src/site-pages/not-found';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/zh/404')({
  head: () => notFoundHead('zh'),
  component: () => <NotFoundPage locale="zh" />,
});

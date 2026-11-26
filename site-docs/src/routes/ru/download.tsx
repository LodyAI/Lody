import { DownloadRoutePage, downloadHead } from '@site/src/site-pages/download';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/ru/download')({
  head: () => downloadHead('ru'),
  component: () => <DownloadRoutePage locale="ru" />,
});

import { DownloadRoutePage, downloadHead } from '@site/src/site-pages/download';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/ja/download')({
  head: () => downloadHead('ja'),
  component: () => <DownloadRoutePage locale="ja" />,
});

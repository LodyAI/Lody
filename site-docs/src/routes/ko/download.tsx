import { DownloadRoutePage, downloadHead } from '@site/src/site-pages/download';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/ko/download')({
  head: () => downloadHead('ko'),
  component: () => <DownloadRoutePage locale="ko" />,
});

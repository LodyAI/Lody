import { DownloadRoutePage, downloadHead } from '@site/src/site-pages/download';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/zh-hant/download')({
  head: () => downloadHead('zh-hant'),
  component: () => <DownloadRoutePage locale="zh-hant" />,
});

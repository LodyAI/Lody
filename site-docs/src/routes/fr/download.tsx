import { DownloadRoutePage, downloadHead } from '@site/src/site-pages/download';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/fr/download')({
  head: () => downloadHead('fr'),
  component: () => <DownloadRoutePage locale="fr" />,
});

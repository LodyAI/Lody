import { DownloadRoutePage, downloadHead } from '@site/src/site-pages/download';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/es/download')({
  head: () => downloadHead('es'),
  component: () => <DownloadRoutePage locale="es" />,
});

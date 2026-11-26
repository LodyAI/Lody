import { NightlyDownloadPage } from '@site/components/nightly-download-page';
import { nightlyDownloadHead } from '@site/src/site-pages/download';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/ru/download_/nightly')({
  head: () => nightlyDownloadHead('ru'),
  component: () => <NightlyDownloadPage locale="ru" />,
});

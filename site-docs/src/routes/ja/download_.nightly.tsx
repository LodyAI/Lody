import { NightlyDownloadPage } from '@site/components/nightly-download-page';
import { nightlyDownloadHead } from '@site/src/site-pages/download';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/ja/download_/nightly')({
  head: () => nightlyDownloadHead('ja'),
  component: () => <NightlyDownloadPage locale="ja" />,
});

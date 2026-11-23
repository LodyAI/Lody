import { NightlyDownloadPage } from '@site/components/nightly-download-page';
import { nightlyDownloadHead } from '@site/src/site-pages/download';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/download_/nightly')({
  head: () => nightlyDownloadHead('en'),
  component: () => <NightlyDownloadPage locale="en" />,
});

import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { DesktopGithubInstallPage } from '@/components/pages/desktop-github-install-page';

export const Route = createFileRoute('/desktop/github-install')({
  component: DesktopGithubInstallCallback,
});

function DesktopGithubInstallCallback() {
  const [deepLink, setDeepLink] = useState<string | null>(null);

  useEffect(() => {
    const url = `lody://github-install${window.location.search}${window.location.hash}`;
    setDeepLink(url);
    window.location.href = url;
  }, []);

  return <DesktopGithubInstallPage deepLink={deepLink} />;
}

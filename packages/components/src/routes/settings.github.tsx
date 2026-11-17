import { createFileRoute, useRouter } from '@tanstack/react-router';
import { useState } from 'react';
import { HomeRoute, type HomeDestination } from './index';
import {
  readGitHubInstallError,
  readGitHubInstallRetry,
  GITHUB_INSTALL_RETRY_PREFIX,
} from '@/lib/github-installation-recovery';

/** A callback without a verified workspace still has a real Web settings landing. */
export const Route = createFileRoute('/settings/github')({
  component: GitHubSettingsLanding,
});

export function GitHubSettingsLanding() {
  const router = useRouter();
  // Own the advice from this landing while its destination commits. A global
  // location subscription would re-run Navigate as the next route takes over.
  const [destination] = useState<HomeDestination>(() => {
    const location = router.state.location;
    const error = readGitHubInstallError(location.searchStr);
    const retry = error
      ? readGitHubInstallRetry(`#${location.hash}`, import.meta.env.VITE_CONVEX_SITE_URL)
      : null;
    return {
      kind: 'github-settings',
      error,
      retryHash: retry ? `${GITHUB_INSTALL_RETRY_PREFIX.slice(1)}${encodeURIComponent(retry)}` : '',
    };
  });
  return <HomeRoute destination={destination} />;
}

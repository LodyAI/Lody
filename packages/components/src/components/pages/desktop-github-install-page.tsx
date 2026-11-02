import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Github } from 'lucide-react';

import { Button } from '@lody/ui/button';
import { SecondaryPage } from '@/components/pages/secondary-page';

/** How long the deep link gets to open the app before the page offers the fallback. */
const FALLBACK_DELAY_MS = 3000;

export interface DesktopGithubInstallPageProps {
  deepLink: string | null;
}

/**
 * Browser landing page for the GitHub App install callback. The route fires the
 * `lody://github-install` deep link itself; the browser cannot see whether the
 * app opened, so the page never claims it did. It offers the link again and,
 * after a moment, a fallback.
 */
export function DesktopGithubInstallPage({ deepLink }: DesktopGithubInstallPageProps) {
  const { t } = useTranslation();
  const [showFallback, setShowFallback] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!deepLink) return undefined;
    const timer = window.setTimeout(() => setShowFallback(true), FALLBACK_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [deepLink]);

  const copyLink = async () => {
    if (!deepLink || !navigator.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(deepLink);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const state = deepLink ? 'ask' : 'arrive';
  const openLabel = t('desktopGithubInstall.openButton', 'Open Lody Desktop');

  const copy = {
    arrive: {
      title: t('desktopGithubInstall.arriveTitle', 'Connecting GitHub'),
      description: t('desktopGithubInstall.arriveDescription', 'Getting Lody Desktop ready'),
    },
    ask: {
      title: t('desktopGithubInstall.title', 'Continue in Lody Desktop'),
      description: t(
        'desktopGithubInstall.description',
        'GitHub is installed. Finish connecting it in the app.'
      ),
    },
  }[state];

  const copyButton = (
    <Button type="button" variant="secondary" size="large" onClick={() => void copyLink()}>
      {copied
        ? t('desktopGithubInstall.copied', 'Copied')
        : t('desktopGithubInstall.copyLink', 'Copy link')}
    </Button>
  );

  return (
    <SecondaryPage
      state={state}
      from={<Github size={22} strokeWidth={1.6} aria-hidden="true" />}
      markLabel={t('desktopGithubInstall.markLabel', 'GitHub and Lody')}
      title={copy.title}
      description={copy.description}
      actions={
        deepLink ? (
          <>
            {copyButton}
            <Button render={<a href={deepLink} />} size="large">
              {openLabel}
            </Button>
          </>
        ) : null
      }
      note={
        showFallback
          ? t(
              'desktopGithubInstall.fallback',
              'Nothing happened? Copy the link and paste it into the address bar.'
            )
          : undefined
      }
    />
  );
}

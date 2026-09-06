'use client';

/**
 * Hero primary CTA: same platform-aware download as the closing CTA.
 */

import { useEffect, useMemo, useState } from 'react';
import { GithubMark } from './github-mark';
import {
  DOWNLOAD_BASE,
  detectPlatform,
  resolvePrimaryDownloadAction,
  type PlatformDownloadLabels,
  type PlatformKey,
} from './landing-platform-download';

export type LandingHeroDownloadCopy = {
  /**
   * Ghost secondary. It is the source-repository link by contract, so the
   * button always carries the GitHub mark.
   */
  secondary: string;
  secondaryHref: string;
  /** Set when `secondaryHref` leaves the site (source repository). */
  secondaryExternal?: boolean;
  webAppHref: string;
  labels: PlatformDownloadLabels;
  /** Link to the full multi-platform download page. */
  otherDownloads: string;
  otherDownloadsHref: string;
  /** Optional Intel Mac link when primary is Apple Silicon. */
  showIntelMac?: boolean;
};

export function LandingHeroDownload({ copy }: { copy: LandingHeroDownloadCopy }) {
  const [platform, setPlatform] = useState<PlatformKey | null>(null);

  useEffect(() => {
    setPlatform(detectPlatform(window.navigator.userAgent, window.navigator.platform));
  }, []);

  const primary = useMemo(
    () =>
      resolvePrimaryDownloadAction({
        platform,
        labels: copy.labels,
        webAppHref: copy.webAppHref,
      }),
    [copy.labels, copy.webAppHref, platform]
  );

  return (
    <div className="underwater-hero__cta-wrap">
      <div className="underwater-hero__cta">
        <a
          className="underwater-btn underwater-btn--primary"
          href={primary.href}
          {...(primary.external
            ? { target: '_blank', rel: 'noreferrer' }
            : primary.download
              ? { download: true }
              : {})}
        >
          {primary.label}
        </a>
        <a
          className="underwater-btn underwater-btn--ghost"
          href={copy.secondaryHref}
          {...(copy.secondaryExternal ? { target: '_blank', rel: 'noreferrer' } : {})}
        >
          <GithubMark className="underwater-btn__icon" />
          {copy.secondary}
        </a>
      </div>
      <div className="underwater-hero__cta-links">
        <a className="underwater-hero__more" href={copy.otherDownloadsHref}>
          {copy.otherDownloads}
        </a>
        {copy.showIntelMac !== false && platform === 'mac-arm' ? (
          <>
            <span className="underwater-hero__link-dot" aria-hidden="true">
              ·
            </span>
            <a
              className="underwater-hero__more"
              href={`${DOWNLOAD_BASE}/Lody-latest-x64.dmg`}
              download
            >
              {copy.labels.macIntel}
            </a>
          </>
        ) : null}
      </div>
    </div>
  );
}

export default LandingHeroDownload;

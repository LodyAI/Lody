'use client';

/**
 * Closing slogan + platform-aware primary download CTA.
 * Detection shared with hero via `landing-platform-download.ts`.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  DOWNLOAD_BASE,
  detectPlatform,
  resolvePrimaryDownloadAction,
  type PlatformDownloadLabels,
  type PlatformKey,
} from './landing-platform-download';

export type LandingCtaCopy = {
  slogan: string;
  /** Shown under the slogan, one short line. */
  lead: string;
  allPlatforms: string;
  allPlatformsHref: string;
  webApp: string;
  webAppHref: string;
  /** Low-key "book a call with the founder" link in the secondary row. */
  bookCall: string;
  bookCallHref: string;
  labels: PlatformDownloadLabels;
};

export function LandingCtaSection({ copy }: { copy: LandingCtaCopy }) {
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
    <section className="uw-cta" aria-labelledby="uw-cta-slogan">
      <div className="uw-cta__inner">
        <h2 className="uw-cta__slogan" id="uw-cta-slogan">
          {copy.slogan}
        </h2>
        <p className="uw-cta__lead">{copy.lead}</p>

        <div className="uw-cta__actions">
          <a
            className="uw-cta__book-call underwater-btn underwater-btn--ghost"
            href={copy.bookCallHref}
            rel="noreferrer"
            target="_blank"
          >
            {copy.bookCall}
          </a>
          <a
            className="uw-cta__primary underwater-btn underwater-btn--primary"
            href={primary.href}
            {...(primary.external
              ? { target: '_blank', rel: 'noreferrer' }
              : primary.download
                ? { download: true }
                : {})}
          >
            {primary.label}
          </a>
          <div className="uw-cta__secondary">
            <a href={copy.allPlatformsHref}>{copy.allPlatforms}</a>
            <span className="uw-cta__dot" aria-hidden="true">
              ·
            </span>
            <a href={copy.webAppHref}>{copy.webApp}</a>
            {platform === 'mac-arm' ? (
              <>
                <span className="uw-cta__dot" aria-hidden="true">
                  ·
                </span>
                <a href={`${DOWNLOAD_BASE}/Lody-latest-x64.dmg`} download>
                  {copy.labels.macIntel}
                </a>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}

export default LandingCtaSection;

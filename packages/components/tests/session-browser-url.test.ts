import { describe, expect, it } from 'vitest';

import {
  buildManagedViewerUrl,
  getManagedPageKey,
  toManagedLogicalUrl,
} from '../src/lib/session-browser-url';

describe('session Browser URL mapping', () => {
  it('preserves the target path and gateway capability when building a viewer URL', () => {
    expect(
      buildManagedViewerUrl('https://session-grant.mylody.app/?__lody_preview_token=secret', {
        protocol: 'http',
        host: '127.0.0.1',
        port: 5173,
        path: '/DownloadPage.vue?vue&type=style&index=0&lang.css#members',
      })
    ).toBe(
      'https://session-grant.mylody.app/DownloadPage.vue?vue&type=style&index=0&lang.css&__lody_preview_token=secret#members'
    );
  });

  it('never exposes preview capability parameters in the logical address', () => {
    expect(
      toManagedLogicalUrl(
        'https://session-grant.mylody.app/DownloadPage.vue?vue&type=style&index=0&lang.css&__lody_preview_token=secret#top',
        'http://localhost:5173/settings'
      )
    ).toBe('http://localhost:5173/DownloadPage.vue?vue&type=style&index=0&lang.css#top');

    expect(
      toManagedLogicalUrl(
        'http://127.0.0.1:64000/dashboard?filter=open&__lody_local_preview_token=secret',
        'http://localhost:5173/settings'
      )
    ).toBe('http://localhost:5173/dashboard?filter=open');
  });

  it('uses a token-free relative page key for annotation filtering', () => {
    expect(
      getManagedPageKey(
        '/DownloadPage.vue?vue&type=style&index=0&lang.css&__lody_preview_token=secret&__lody_local_preview_token=local#members',
        'http://localhost:5173/'
      )
    ).toBe('/DownloadPage.vue?vue&type=style&index=0&lang.css#members');
  });
});

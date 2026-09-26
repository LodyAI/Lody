import { describe, expect, it } from 'vitest';

import {
  PREVIEW_ACCESS_TOKEN_COOKIE,
  PREVIEW_EMBEDDER_POLICY,
  PREVIEW_RESOURCE_POLICY,
  applyPreviewEmbeddingHeaders,
  buildPreviewAccessTokenCookie,
  hasReportedPreviewTarget,
  isQuickTunnelViewerUrl,
  removePreviewAccessTokenFromSearch,
  removePreviewQueryParamFromSearch,
  sanitizePreviewProxyResponseHeaders,
  setPreviewQueryParamInUrl,
  stripPreviewFrameAncestorsDirective,
} from '../src/preview';

describe('Quick Tunnel viewer URL shape', () => {
  it('requires an HTTPS Quick origin and capability, independently of old preview domains', () => {
    expect(
      isQuickTunnelViewerUrl(
        'https://preview-example.trycloudflare.com/page?__lody_preview_token=capability'
      )
    ).toBe(true);
    for (const url of [
      'https://preview-example.trycloudflare.com/',
      'https://preview-example.trycloudflare.com/?__lody_preview_token=',
      'http://preview-example.trycloudflare.com/?__lody_preview_token=capability',
      'https://user:pass@preview-example.trycloudflare.com/?__lody_preview_token=capability',
      'https://preview-example.trycloudflare.com:8080/?__lody_preview_token=capability',
      'https://nested.preview-example.trycloudflare.com/?__lody_preview_token=capability',
      'https://preview-example.trycloudflare.com.attacker.test/?__lody_preview_token=capability',
      'https://preview-example.mylody.app/?__lody_preview_token=capability',
    ])
      expect(isQuickTunnelViewerUrl(url)).toBe(false);
  });
});

describe('preview access token cookie', () => {
  it('removes preview access tokens without normalizing Vite bare query params', () => {
    expect(
      removePreviewAccessTokenFromSearch(
        '?vue&type=style&index=0&lang.css&__lody_preview_token=preview-token'
      )
    ).toBe('?vue&type=style&index=0&lang.css');
    expect(
      removePreviewAccessTokenFromSearch(
        '?__lody_preview_token=preview-token&vue&type=style&index=0&lang.css'
      )
    ).toBe('?vue&type=style&index=0&lang.css');
    expect(removePreviewAccessTokenFromSearch('?__lody_preview_token=preview-token')).toBe('');
  });

  it('adds and removes preview capabilities without normalizing bare query params', () => {
    const viewerUrl = setPreviewQueryParamInUrl(
      new URL(
        'http://127.0.0.1:5173/DownloadPage.vue?vue&type=style&index=0&lang.css&__lody_local_preview_token=stale'
      ),
      '__lody_local_preview_token',
      'local token'
    );

    expect(viewerUrl.toString()).toBe(
      'http://127.0.0.1:5173/DownloadPage.vue?vue&type=style&index=0&lang.css&__lody_local_preview_token=local%20token'
    );
    expect(removePreviewQueryParamFromSearch(viewerUrl.search, '__lody_local_preview_token')).toBe(
      '?vue&type=style&index=0&lang.css'
    );
  });

  it('uses partitioned third-party cookie attributes for embedded previews', () => {
    const now = 1_800_000;
    const cookie = buildPreviewAccessTokenCookie({
      token: 'preview token/with+chars',
      expiresAt: now + 120_000,
      now,
    });

    expect(cookie).toBe(
      `${PREVIEW_ACCESS_TOKEN_COOKIE}=preview%20token%2Fwith%2Bchars; Max-Age=120; Path=/; Secure; HttpOnly; SameSite=None; Partitioned`
    );
  });

  it('clamps preview access token cookie max-age', () => {
    const now = 1_800_000;

    expect(
      buildPreviewAccessTokenCookie({
        token: 'preview-token',
        expiresAt: now + 12 * 60 * 60 * 1000,
        now,
      })
    ).toContain('Max-Age=28800');
    expect(
      buildPreviewAccessTokenCookie({
        token: 'preview-token',
        expiresAt: now - 1_000,
        now,
      })
    ).toContain('Max-Age=60');
  });
});

describe('preview proxy response headers', () => {
  it('removes frame embedding blockers while preserving other response headers', () => {
    expect(
      sanitizePreviewProxyResponseHeaders([
        ['Content-Type', 'text/html; charset=utf-8'],
        ['X-Frame-Options', 'SAMEORIGIN'],
        [
          'Content-Security-Policy',
          "default-src 'self'; frame-ancestors 'none'; script-src 'self' 'unsafe-inline'",
        ],
        ['Content-Security-Policy-Report-Only', "frame-ancestors 'none'"],
      ])
    ).toEqual([
      ['Content-Type', 'text/html; charset=utf-8'],
      ['Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'"],
      ['Content-Security-Policy-Report-Only', "frame-ancestors 'none'"],
    ]);
  });

  it('drops content-security-policy when only frame-ancestors remains', () => {
    expect(
      sanitizePreviewProxyResponseHeaders([
        ['content-security-policy', "frame-ancestors 'self'"],
        ['x-frame-options', 'DENY'],
        ['cache-control', 'no-store'],
      ])
    ).toEqual([['cache-control', 'no-store']]);
  });

  it('strips frame-ancestors case-insensitively from a CSP value', () => {
    expect(
      stripPreviewFrameAncestorsDirective(
        "  FRAME-ANCESTORS https://example.com ; default-src 'self';"
      )
    ).toBe("default-src 'self'");
  });
});

describe('preview embedding headers', () => {
  it('sets COEP/CORP that match the embedder app policy', () => {
    const headers = applyPreviewEmbeddingHeaders(new Headers());
    expect(headers.get('Cross-Origin-Embedder-Policy')).toBe(PREVIEW_EMBEDDER_POLICY);
    expect(headers.get('Cross-Origin-Resource-Policy')).toBe(PREVIEW_RESOURCE_POLICY);
    expect(PREVIEW_EMBEDDER_POLICY).toBe('credentialless');
    expect(PREVIEW_RESOURCE_POLICY).toBe('cross-origin');
  });

  it('overrides any pre-existing embedder/resource policy from the upstream response', () => {
    const headers = applyPreviewEmbeddingHeaders(
      new Headers({
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Content-Type': 'text/html',
      })
    );
    expect(headers.get('Cross-Origin-Embedder-Policy')).toBe('credentialless');
    expect(headers.get('Cross-Origin-Resource-Policy')).toBe('cross-origin');
    expect(headers.get('Content-Type')).toBe('text/html');
  });
});

describe('preview entry point availability', () => {
  it('stays hidden until the agent reports a candidate', () => {
    expect(hasReportedPreviewTarget({})).toBe(false);
    expect(hasReportedPreviewTarget({ candidateStatus: 'none' })).toBe(false);
    // A rejected report (non-loopback host, dead port, …) is not a target.
    expect(hasReportedPreviewTarget({ candidateStatus: 'invalid' })).toBe(false);
    // An idle/finished connection alone leaves nothing to open.
    expect(hasReportedPreviewTarget({ connectionStatus: 'idle' })).toBe(false);
    expect(hasReportedPreviewTarget({ connectionStatus: 'revoked' })).toBe(false);
    expect(hasReportedPreviewTarget({ connectionStatus: 'expired' })).toBe(false);
    expect(hasReportedPreviewTarget({ connectionStatus: 'failed' })).toBe(false);
  });

  it('appears for a reported candidate or a live connection', () => {
    expect(hasReportedPreviewTarget({ candidateStatus: 'reported' })).toBe(true);
    expect(hasReportedPreviewTarget({ candidateStatus: 'validating' })).toBe(true);
    expect(hasReportedPreviewTarget({ candidateStatus: 'available' })).toBe(true);
    // A live connection survives a candidate that was cleared or invalidated.
    expect(
      hasReportedPreviewTarget({ candidateStatus: 'invalid', connectionStatus: 'active' })
    ).toBe(true);
    expect(hasReportedPreviewTarget({ connectionStatus: 'creating' })).toBe(true);
  });
});

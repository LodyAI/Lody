import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendClientBuildInfo, collectClientBuildInfo } from '../src/lib/client-build-info';

import {
  buildErrorBoundaryReport,
  collectErrorBoundaryEnvironment,
} from '../src/lib/error-boundary-report';

afterEach(() => vi.unstubAllGlobals());

describe('reporting client provenance', () => {
  it('carries the frozen desktop identity into crash and description-only reports', () => {
    vi.stubGlobal('__APP_VERSION__', '1.2.3-nightly.42');
    vi.stubGlobal('__DESKTOP_RELEASE_CHANNEL__', 'nightly');
    vi.stubGlobal('__GIT_COMMIT__', 'a'.repeat(40));
    vi.stubGlobal('__OSS_GIT_COMMIT__', 'b'.repeat(40));
    vi.stubGlobal('__BUILD_DATE__', '2026-09-23T00:00:00.000Z');
    const environment = collectErrorBoundaryEnvironment();
    expect(collectClientBuildInfo()).toEqual({
      appVersion: '1.2.3-nightly.42',
      releaseChannel: 'nightly',
      build: 'a'.repeat(40),
      ossCommit: 'b'.repeat(40),
      buildDate: '2026-09-23T00:00:00.000Z',
    });
    const crash = buildErrorBoundaryReport({ error: 'render failed', environment });
    expect(crash.text).toContain('Release channel: nightly');
    expect(crash.text).toContain(`Build: ${'a'.repeat(40)}`);
    expect(crash.text).toContain(`Open-source commit: ${'b'.repeat(40)}`);
    // Even a caller passing a broader diagnostic object cannot add ambient data
    // to the normal bug report, or silently change the user's description.
    expect(
      appendClientBuildInfo('My exact description\n', {
        ...environment,
        url: 'https://example.test/private-path',
      } as typeof environment)
    ).toBe(
      [
        'My exact description\n',
        '',
        '---',
        'Reporting client build',
        'Version: 1.2.3-nightly.42',
        'Channel: nightly',
        `Build: ${'a'.repeat(40)}`,
        `Open-source commit: ${'b'.repeat(40)}`,
        'Build date: 2026-09-23T00:00:00.000Z',
      ].join('\n')
    );
  });

  it('keeps reports usable in compositions without injected build constants', () => {
    for (const key of [
      '__APP_VERSION__',
      '__DESKTOP_RELEASE_CHANNEL__',
      '__GIT_COMMIT__',
      '__OSS_GIT_COMMIT__',
      '__BUILD_DATE__',
    ]) {
      vi.stubGlobal(key, undefined);
    }
    expect(appendClientBuildInfo('original text')).toBe('original text');
    const report = buildErrorBoundaryReport({
      error: 'bare',
      environment: collectClientBuildInfo(),
    });
    expect(report.text).toBe('bare');
  });
});

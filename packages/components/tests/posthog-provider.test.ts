import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POSTHOG_OPTIONS } from '../src/providers/posthog-options';

import {
  postHogPrivacy,
  holdPrivateTelemetrySurface,
  installWorkspaceTelemetryScope,
  setTelemetryRouteTarget,
  suspendWorkspaceTelemetry,
} from '../src/lib/posthog-privacy';

function runBeforeSend(event: {
  event: string;
  properties?: Record<string, unknown>;
}): { event: string; properties?: Record<string, unknown> } | null {
  const beforeSend = POSTHOG_OPTIONS.before_send;
  if (typeof beforeSend !== 'function') {
    throw new Error('Expected PostHog before_send to be configured');
  }
  return beforeSend(event) as { event: string; properties?: Record<string, unknown> } | null;
}

describe('PostHog provider options', () => {
  let uninstall: () => void;
  beforeEach(() => {
    uninstall = installWorkspaceTelemetryScope(() => 'plain-test-scope');
    setTelemetryRouteTarget('test', true);
  });
  afterEach(() => {
    uninstall();
    vi.unstubAllGlobals();
  });

  it('keeps an encrypted approval private above ordinary workspaces until all actual surfaces retire', () => {
    let current = 'ordinary-A';
    const removeScope = installWorkspaceTelemetryScope(() => current);
    const first = holdPrivateTelemetrySurface(),
      nested = holdPrivateTelemetrySurface();
    const frame = {
      event: '$snapshot',
      properties: { $snapshot_data: ['synthetic pairing code'] },
    };
    try {
      expect(runBeforeSend(frame)).toBeNull();
      first();
      first();
      expect(runBeforeSend(frame)).toBeNull();
      current = 'ordinary-B';
      setTelemetryRouteTarget('B', true);
      expect(runBeforeSend(frame)).toBeNull();
      expect(
        runBeforeSend({
          event: '$exception',
          properties: { message: 'synthetic device name', error_code: 'e2ee_pairing_expired' },
        })?.properties
      ).not.toHaveProperty('message');
      nested();
      expect(
        runBeforeSend({ event: '$snapshot', properties: { $snapshot_data: ['ordinary-B'] } })
      ).not.toBeNull();
    } finally {
      first();
      nested();
      removeScope();
    }
  });

  it('drops snapshots and redacts exceptions across an unknown workspace transition', () => {
    const snapshot = { event: '$snapshot', properties: { $snapshot_data: ['private path'] } };
    expect(runBeforeSend(snapshot)).toEqual(snapshot);
    suspendWorkspaceTelemetry();
    expect(runBeforeSend(snapshot)).toBeNull();
    expect(
      runBeforeSend({
        event: '$exception',
        properties: {
          $exception_list: [{ value: 'private error', stacktrace: { frames: ['private path'] } }],
          arbitrary: { secret: 'private content' },
          error_code: 'e2ee_feature_unavailable',
        },
      })
    ).toEqual({
      event: '$exception',
      properties: {
        token: undefined,
        distinct_id: undefined,
        $exception_list: [{ type: 'Error', value: 'e2ee_feature_unavailable' }],
        error_code: 'e2ee_feature_unavailable',
      },
    });
  });

  it('keeps recovery recordings and late exceptions private until both UI and command settle', () => {
    const releaseUI = holdPrivateTelemetrySurface();
    const releaseCommand = holdPrivateTelemetrySurface();
    const prepared = postHogPrivacy.prepareException([new Error('recovery-secret')]);
    releaseUI();
    setTelemetryRouteTarget('test', true);
    expect(
      runBeforeSend({ event: '$snapshot', properties: { $snapshot_data: ['recovery-secret'] } })
    ).toBeNull();
    releaseUI(); // releasing one holder twice cannot release the pending command
    expect(postHogPrivacy.isAllowed()).toBe(false);
    releaseCommand();
    expect(postHogPrivacy.isAllowed()).toBe(true);
    const late = runBeforeSend({
      event: '$exception',
      properties: {
        ...(prepared[1] as Record<string, unknown>),
        $exception_list: [{ value: 'recovery-secret' }],
      },
    });
    expect(JSON.stringify(late)).not.toContain('recovery-secret');
  });

  it('keeps delayed exceptions redacted across unknown and returning plaintext scopes', () => {
    const plaintext = postHogPrivacy.prepareException([
      new Error('private-before-switch'),
      { nested: { file: 'private path' } },
    ]);
    suspendWorkspaceTelemetry();
    const unknown = postHogPrivacy.prepareException([
      new Error('private-unknown'),
      { nested: { file: 'private path' } },
    ]);
    setTelemetryRouteTarget('test', true);
    for (const prepared of [plaintext, unknown]) {
      const event = runBeforeSend({
        event: '$exception',
        properties: {
          ...(prepared[1] as Record<string, unknown>),
          $exception_list: [{ value: String(prepared[0]) }],
          $exception_steps: [{ message: 'private breadcrumb' }],
        },
      });
      expect(JSON.stringify(event)).not.toContain('private');
      expect(event).toMatchObject({ properties: { error_code: 'redacted_exception' } });
    }
  });
});

it('keeps GitHub installation retry capabilities out of the locked SDK replay URL metadata', () => {
  const require = createRequire(import.meta.url);
  const sdkRoot = dirname(require.resolve('posthog-js/package.json'));
  // Exercise the real locked recorder URL masking boundary without starting replay timers.
  const { LazyLoadedSessionRecording } = require(
    join(sdkRoot, 'lib/src/extensions/replay/external/lazy-loaded-session-recorder.js')
  );
  const recorder = Object.assign(Object.create(LazyLoadedSessionRecording.prototype), {
    _instance: { config: { ...POSTHOG_OPTIONS } },
  }) as {
    _instance: { config: { disable_capture_url_hashes?: boolean } };
    _maskReplayUrl: (url: string) => string;
  };
  const capability =
    'https://lody.example/team/settings/github#github-install-retry=SIGNED_INSTALL_STATE_SECRET';
  expect(recorder._maskReplayUrl(capability)).toBe('https://lody.example/team/settings/github');
  recorder._instance.config.disable_capture_url_hashes = false;
  expect(recorder._maskReplayUrl(capability)).toContain('SIGNED_INSTALL_STATE_SECRET');
});

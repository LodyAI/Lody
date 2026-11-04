import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POSTHOG_OPTIONS } from '../src/providers/posthog-options';

import {
  postHogPrivacy,
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

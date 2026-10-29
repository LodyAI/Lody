import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConvexError } from 'convex/values';
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

  it('marks Electron renderer events as the desktop analytics library', () => {
    vi.stubGlobal('window', {
      __LODY_ELECTRON__: true,
      __LODY_APP_INFO__: { app_version: '1.2.3' },
    });

    expect(
      runBeforeSend({
        event: 'session/start_success',
        properties: {
          platform: 'web',
          $lib: 'web',
          existing: true,
        },
      })
    ).toMatchObject({
      event: 'session/start_success',
      properties: {
        platform: 'electron',
        electron_process: 'renderer',
        $lib: 'desktop',
        $lib_version: '1.2.3',
        existing: true,
      },
    });
  });

  it('marks native iOS events as the iOS analytics library', () => {
    vi.stubGlobal('window', {
      __LODY_NATIVE__: true,
      __LODY_APP_INFO__: { app_version: '1.2.3', native_platform: 'ios' },
    });

    expect(
      runBeforeSend({
        event: 'app/launch',
        properties: {
          platform: 'web',
          $lib: 'web',
          existing: true,
        },
      })
    ).toMatchObject({
      event: 'app/launch',
      properties: {
        platform: 'mobile',
        native_platform: 'ios',
        mobile_process: 'webview',
        $lib: 'iOS',
        $lib_version: '1.2.3',
        existing: true,
      },
    });
  });

  it('marks native Android events as the Android analytics library', () => {
    vi.stubGlobal('window', {
      __LODY_NATIVE__: true,
      __LODY_APP_INFO__: { app_version: '1.2.3', native_platform: 'android' },
    });

    expect(
      runBeforeSend({
        event: 'app/launch',
        properties: {
          platform: 'web',
          $lib: 'web',
        },
      })
    ).toMatchObject({
      event: 'app/launch',
      properties: {
        platform: 'mobile',
        native_platform: 'android',
        mobile_process: 'webview',
        $lib: 'Android',
        $lib_version: '1.2.3',
      },
    });
  });

  it('leaves web events on the default PostHog library path', () => {
    vi.stubGlobal('window', {});

    expect(
      runBeforeSend({
        event: 'session/start_success',
        properties: {
          platform: 'web',
          $lib: 'web',
        },
      })
    ).toMatchObject({
      properties: {
        platform: 'web',
        $lib: 'web',
      },
    });
  });

  it('drops ResizeObserver loop browser exception noise', () => {
    expect(
      runBeforeSend({
        event: '$exception',
        properties: {
          $exception_message: 'ResizeObserver loop completed with undelivered notifications.',
        },
      })
    ).toBeNull();

    expect(
      runBeforeSend({
        event: '$exception',
        properties: {
          $exception_list: [{ value: 'ResizeObserver loop limit exceeded' }],
        },
      })
    ).toBeNull();
  });

  it('drops serialized auth errors from manual and automatic exception capture', () => {
    const error = new ConvexError({ kind: 'lody.auth', code: 'unauthenticated' });
    const wrapped = `[CONVEX A(promptShortcuts:getStreamToken)] [Request ID: test] Server Error
Uncaught ConvexError: Uncaught ${error.toString()}
    at handler (convex/promptShortcuts.ts:422:25)
    Called by client`;
    for (const message of [error.message, error.toString(), wrapped]) {
      for (const properties of [
        { $exception_message: message },
        { $exception_description: message },
        { $exception_list: [{ type: 'ConvexError', value: message }] },
        { $exception_list: [{ type: 'ConvexError', message }] },
      ]) {
        expect(runBeforeSend({ event: '$exception', properties })).toBeNull();
      }
    }
  });

  it('keeps unrelated errors and malformed or unnamespaced auth messages', () => {
    for (const message of [
      'unauthenticated',
      'ConvexError: unauthenticated',
      'ConvexError: {"kind":"other.auth","code":"unauthenticated"}',
      'ConvexError: {"kind":"lody.auth","code":"forbidden"}',
      'ConvexError: {"kind":"lody.auth","code":"unauthenticated"',
      'TypeError: Cannot read properties of undefined',
    ]) {
      const event = { event: '$exception', properties: { $exception_message: message } };
      expect(runBeforeSend(event)).toEqual(event);
    }
    expect(runBeforeSend({ event: '$exception' })).not.toBeNull();
  });

  it('keeps mixed exception chains and non-exception analytics', () => {
    const auth = new ConvexError({ kind: 'lody.auth', code: 'unauthenticated' }).toString();
    const properties = {
      $exception_message: auth,
      $exception_list: [
        { type: 'ConvexError', value: auth },
        { type: 'TypeError', value: 'Cannot read properties of undefined' },
      ],
    };
    const mixed = { event: '$exception', properties };
    expect(runBeforeSend(mixed)).toEqual(mixed);
    const analytics = { event: 'auth/recovery', properties: { $exception_message: auth } };
    expect(runBeforeSend(analytics)).toEqual(analytics);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConvexError } from 'convex/values';
import { POSTHOG_OPTIONS } from '../src/providers/posthog-provider';

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
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('enables automatic session recording with privacy masking', () => {
    expect(POSTHOG_OPTIONS.disable_session_recording).toBe(false);
    expect(POSTHOG_OPTIONS.disable_external_dependency_loading).toBe(false);
    // `advanced_disable_flags: true` skips the `/flags` request that delivers the
    // server-side `sessionRecording` config, so the recorder never starts. Guard
    // against it silently coming back and killing Session Replay.
    expect(POSTHOG_OPTIONS.advanced_disable_flags).not.toBe(true);
    expect(POSTHOG_OPTIONS.enable_recording_console_log).toBe(false);
    expect(POSTHOG_OPTIONS.capture_performance).toBe(false);

    expect(POSTHOG_OPTIONS.mask_all_element_attributes).toBe(true);
    expect(POSTHOG_OPTIONS.mask_all_text).toBe(true);
    expect(POSTHOG_OPTIONS.session_recording).toMatchObject({
      maskAllInputs: true,
      maskTextSelector: '*',
    });
    expect(POSTHOG_OPTIONS.session_recording?.maskTextFn?.('repo/path secret')).toBe(
      '********* ******'
    );
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

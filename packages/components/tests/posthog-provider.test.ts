import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POSTHOG_OPTIONS } from '../src/providers/posthog-options';

import {
  postHogPrivacy,
  createPostHogPrivacy,
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
    _instance: {
      config: { ...POSTHOG_OPTIONS, session_recording: { ...POSTHOG_OPTIONS.session_recording } },
    },
  }) as {
    _instance: {
      config: {
        disable_capture_url_hashes?: boolean;
        session_recording: { maskCapturedNetworkRequestFn?: unknown };
      };
    };
    _maskReplayUrl: (url: string) => string;
  };
  const capability =
    'https://lody.example/team/settings/github#github-install-retry=SIGNED_INSTALL_STATE_SECRET';
  expect(recorder._maskReplayUrl(capability)).toBe('https://lody.example/team/settings/github');
  recorder._instance.config.disable_capture_url_hashes = false;
  delete recorder._instance.config.session_recording.maskCapturedNetworkRequestFn;
  expect(recorder._maskReplayUrl(capability)).toContain('SIGNED_INSTALL_STATE_SECRET');
});

it.each([
  '?state=QUERY_CAPABILITY_SECRET&theme=dark',
  '?github-install-retry=https%3A%2F%2Fcallback.example%2F%3Fstate%3DQUERY_CAPABILITY_SECRET&theme=dark',
  '?github_install_error=temporarily_unavailable%23github-install-retry%3Dhttps%253A%252F%252Fcallback.example%252F%253Fstate%253DQUERY_CAPABILITY_SECRET&theme=dark',
  '?next=https%253A%252F%252Fcallback.example%252F%253Fstate%253DQUERY_CAPABILITY_SECRET&theme=dark',
])('keeps accidental query capabilities out of real SDK replay metadata: %s', (query) => {
  const require = createRequire(import.meta.url);
  const sdkRoot = dirname(require.resolve('posthog-js/package.json'));
  const { LazyLoadedSessionRecording } = require(
    join(sdkRoot, 'lib/src/extensions/replay/external/lazy-loaded-session-recorder.js')
  );
  const recorder = Object.assign(Object.create(LazyLoadedSessionRecording.prototype), {
    _instance: {
      config: { ...POSTHOG_OPTIONS, session_recording: { ...POSTHOG_OPTIONS.session_recording } },
    },
  }) as {
    _maskReplayUrl: (url: string) => string;
    _instance: { config: { session_recording: { maskCapturedNetworkRequestFn?: unknown } } };
  };
  const source = `https://lody.example/team/chat${query}`;
  const masked = recorder._maskReplayUrl(source);
  expect(masked).not.toContain('QUERY_CAPABILITY_SECRET');
  expect(new URL(masked).searchParams.get('theme')).toBe('dark');
  delete recorder._instance.config.session_recording.maskCapturedNetworkRequestFn;
  expect(recorder._maskReplayUrl(source)).toContain('QUERY_CAPABILITY_SECRET');
});

it('scrubs nested replay and exception query contamination while keeping neutral diagnostics', () => {
  const uninstall = installWorkspaceTelemetryScope(() => 'ordinary');
  setTelemetryRouteTarget('ordinary', true);
  const contaminated =
    'https://lody.example/team/chat?github_install_error=temporarily_unavailable%23github-install-retry%3Dhttps%253A%252F%252Fcallback.example%252F%253Fstate%253DQUERY_CAPABILITY_SECRET&theme=dark';
  try {
    for (const event of ['$snapshot', '$exception', 'navigation/failed']) {
      const result = runBeforeSend({
        event,
        properties: {
          state: 'loading',
          error_code: 'temporarily_unavailable',
          nested: [
            {
              data: {
                href: contaminated,
                detail: encodeURIComponent(contaminated),
                neutral: 'https://lody.example/team/chat?theme=dark&tab=github',
              },
            },
          ],
        },
      });
      expect(JSON.stringify(result)).not.toContain('QUERY_CAPABILITY_SECRET');
      expect(result?.properties?.state).toBe('loading');
      expect(result?.properties?.error_code).toBe('temporarily_unavailable');
      expect(result?.properties?.nested).toEqual([
        {
          data: {
            href: 'https://lody.example/team/chat?theme=dark',
            detail: '[redacted_installation_capability]',
            neutral: 'https://lody.example/team/chat?theme=dark&tab=github',
          },
        },
      ]);
    }
  } finally {
    uninstall();
  }
});

it('scrubs a queued replay URL contaminated after capture before it reaches the transport encoder', () => {
  const bodies: string[] = [];
  const client = {
    __loaded: false,
    _send_request: (options: { data: unknown }) => {
      bodies.push(JSON.stringify(options.data));
    },
  };
  const privacy = createPostHogPrivacy(() => 'ordinary');
  privacy.attach(client as never);
  const frame = {
    event: '$snapshot',
    properties: {
      token: 'synthetic-project-key',
      $snapshot_data: [{ data: { href: 'https://lody.example/team/chat?theme=dark' } }],
    },
  };
  privacy.beforeSend(frame);
  frame.properties.$snapshot_data[0]!.data.href =
    'https://lody.example/team/chat?state=QUEUED_CAPABILITY_SECRET&theme=dark';
  client._send_request({ data: [frame] });
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).not.toContain('QUEUED_CAPABILITY_SECRET');
  expect(bodies[0]).toContain('theme=dark');
  expect(bodies[0]).toContain('synthetic-project-key');
});

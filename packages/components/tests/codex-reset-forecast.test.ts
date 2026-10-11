import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CODEX_RESETS_STATUS_URL,
  canShowCodexResetForecast,
  fetchCodexResetStatus,
  formatCodexResetExpiry,
  isCodexResetWatchExpired,
  normalizeForecastWindowText,
  parseCacheControlMaxAgeMs,
  parseCodexResetStatusResponse,
  sanitizeExternalUrl,
  selectActiveCodexResetWatch,
} from '../src/lib/codex-reset-forecast';

const OBSERVED_AT = '2026-08-20T05:00:00.000Z';
const EXPIRES_AT = '2026-08-20T11:00:00.000Z';
const OBSERVED_MS = Date.parse(OBSERVED_AT);
const EXPIRES_MS = Date.parse(EXPIRES_AT);

const watchResponse = (overrides: Record<string, unknown> = {}) => ({
  data: {
    latest_reset: null,
    active_watch: {
      level: 'strong',
      reset_chance_percent: 65,
      forecast_window: 'the next 6 hours',
      observed_at: OBSERVED_AT,
      expires_at: EXPIRES_AT,
      text: 'Looks like a reset is coming.',
      source: {
        type: 'x_post',
        author: 'thsottiaux',
        url: 'https://x.com/thsottiaux/status/1',
      },
      ...overrides,
    },
    stats: { total: 43, last_reset_at: null, days_since_last: null, avg_interval_days: null },
  },
  meta: { api_version: 'v1', generated_at: '2026-08-20T05:51:13.945Z' },
});

describe('normalizeForecastWindowText', () => {
  // `forecast_window` is free text and not necessarily a duration, so the phrase
  // is preserved verbatim: only whitespace and a trailing period are tidied. The
  // UI presents it as a labelled window rather than splicing it into a sentence.
  it.each([
    ['the next 6 hours', 'the next 6 hours'],
    ['next 24 hours', 'next 24 hours'],
    ['within 2 days', 'within 2 days'],
    ['later today.', 'later today'],
    ['  6-12   hours  ', '6-12 hours'],
    ['sometime after the weekend', 'sometime after the weekend'],
  ])('normalizes %j to %j', (raw, expected) => {
    expect(normalizeForecastWindowText(raw)).toBe(expected);
  });
});

describe('formatCodexResetExpiry', () => {
  it('uses semantic day labels in the selected local time zone', () => {
    const shanghaiNow = Date.parse('2026-08-19T10:00:00.000Z');
    const newYorkNow = Date.parse('2026-08-20T06:00:00.000Z');

    expect(formatCodexResetExpiry(EXPIRES_MS, shanghaiNow, 'zh_CN', 'Asia/Shanghai')).toBe(
      '明天 19:00'
    );
    expect(formatCodexResetExpiry(EXPIRES_MS, newYorkNow, 'en-US', 'America/New_York')).toBe(
      'Today 7:00 AM'
    );
  });

  it('falls back to a localized date when the expiry is not today or tomorrow', () => {
    const now = Date.parse('2026-08-17T11:00:00.000Z');

    expect(formatCodexResetExpiry(EXPIRES_MS, now, 'en-US', 'UTC')).toBe('Aug 20, 2026, 11:00 AM');
  });
});

describe('sanitizeExternalUrl', () => {
  it('keeps http(s) URLs', () => {
    expect(sanitizeExternalUrl('https://x.com/a/1')).toBe('https://x.com/a/1');
  });

  it.each(['javascript:alert(1)', 'data:text/html,<script>', 'not a url', '', null, undefined])(
    'rejects %j',
    (raw) => {
      expect(sanitizeExternalUrl(raw)).toBeNull();
    }
  );
});

describe('parseCodexResetStatusResponse', () => {
  it.each([undefined, null])('accepts an absent scheduled reset (%j)', (scheduled_reset) => {
    expect(
      parseCodexResetStatusResponse({ data: { active_watch: null, scheduled_reset } })
        ?.scheduledReset
    ).toBeNull();
  });

  it.each(['2026-10-02T17:00:00Z', null, 'invalid'])(
    'normalizes a scheduled reset independently of a watch (%j)',
    (scheduled_for) => {
      const status = parseCodexResetStatusResponse({
        data: {
          active_watch: null,
          latest_reset: {
            announced_at: OBSERVED_AT,
            text: 'Earlier reset.',
            source: { type: 'observed' },
          },
          scheduled_reset: {
            status: 'scheduled',
            announced_at: OBSERVED_AT,
            scheduled_for,
            text: 'A reset is scheduled.',
            source: { author: 'example', url: 'https://example.com/reset' },
          },
        },
      });
      expect(status?.watch).toBeNull();
      expect(status?.latestReset?.text).toBe('Earlier reset.');
      expect(status?.scheduledReset).toEqual({
        announcedAtIso: OBSERVED_AT,
        announcedAtMs: OBSERVED_MS,
        scheduledForIso:
          scheduled_for === '2026-10-02T17:00:00Z' ? '2026-10-02T17:00:00.000Z' : null,
        scheduledForMs: scheduled_for === '2026-10-02T17:00:00Z' ? Date.parse(scheduled_for) : null,
        text: 'A reset is scheduled.',
        source: { author: 'example', url: 'https://example.com/reset' },
      });
    }
  );

  it('normalizes an active watch', () => {
    const status = parseCodexResetStatusResponse(watchResponse());

    expect(status?.watch).toEqual({
      level: 'strong',
      chancePercent: 65,
      windowText: 'the next 6 hours',
      observedAtIso: OBSERVED_AT,
      observedAtMs: OBSERVED_MS,
      expiresAtIso: EXPIRES_AT,
      expiresAtMs: EXPIRES_MS,
      text: 'Looks like a reset is coming.',
      source: { author: 'thsottiaux', url: 'https://x.com/thsottiaux/status/1' },
    });
  });

  it('accepts the documented active_watch: null shape and keeps the latest reset', () => {
    const status = parseCodexResetStatusResponse({
      data: {
        latest_reset: {
          id: '2087706104814023111',
          announced_at: '2026-08-13T01:01:37.000Z',
          text: 'Enjoy a nice reset everyone.',
          source: {
            type: 'x_post',
            author: 'thsottiaux',
            url: 'https://x.com/thsottiaux/status/2087706104814023111',
          },
        },
        active_watch: null,
        stats: { total: 43, last_reset_at: null, days_since_last: 7.2, avg_interval_days: 7.9 },
      },
      meta: { api_version: 'v1', generated_at: '2026-08-20T05:51:13.945Z' },
    });

    expect(status).not.toBeNull();
    expect(status?.watch).toBeNull();
    expect(status?.latestReset?.announcedAtMs).toBe(Date.parse('2026-08-13T01:01:37.000Z'));
  });

  it('keeps the latest reset when its source omits the author', () => {
    const status = parseCodexResetStatusResponse({
      data: {
        latest_reset: {
          announced_at: '2026-08-25T14:30:00.000Z',
          text: 'A reset was observed.',
          source: {
            type: 'observed',
            url: 'https://x.com/thsottiaux/status/2092311059197808936',
          },
        },
        active_watch: null,
      },
    });

    expect(status).not.toBeNull();
    expect(status?.latestReset).toMatchObject({
      text: 'A reset was observed.',
      source: null,
    });
  });

  it('keeps a watch without a numeric probability', () => {
    const status = parseCodexResetStatusResponse(watchResponse({ reset_chance_percent: null }));

    expect(status?.watch?.chancePercent).toBeNull();
  });

  it('clamps and rounds an out-of-range probability', () => {
    expect(
      parseCodexResetStatusResponse(watchResponse({ reset_chance_percent: 140 }))?.watch
        ?.chancePercent
    ).toBe(100);
    expect(
      parseCodexResetStatusResponse(watchResponse({ reset_chance_percent: 64.6 }))?.watch
        ?.chancePercent
    ).toBe(65);
  });

  it('drops a level this build does not know instead of mislabelling it', () => {
    expect(
      parseCodexResetStatusResponse(watchResponse({ level: 'imminent' }))?.watch?.level
    ).toBeNull();
  });

  it('drops an unsafe source URL but keeps the forecast', () => {
    const status = parseCodexResetStatusResponse(
      watchResponse({ source: { type: 'x_post', author: 'a', url: 'javascript:alert(1)' } })
    );

    expect(status?.watch?.source).toBeNull();
    expect(status?.watch?.chancePercent).toBe(65);
  });

  // A watch we cannot place in time or describe cannot be shown honestly.
  it.each([
    { forecast_window: '   ' },
    { expires_at: 'not-a-date' },
    { observed_at: 'not-a-date' },
  ])('discards an unusable watch (%j)', (overrides) => {
    expect(parseCodexResetStatusResponse(watchResponse(overrides))?.watch).toBeNull();
  });

  it.each([null, {}, { data: { active_watch: 3 } }, { data: { latest_reset: 'x' } }, 'nope'])(
    'returns null for an unrecognized response (%j)',
    (value) => {
      expect(parseCodexResetStatusResponse(value)).toBeNull();
    }
  );
});

describe('selectActiveCodexResetWatch', () => {
  const status = parseCodexResetStatusResponse(watchResponse());

  it('returns the watch while it is still in force', () => {
    expect(selectActiveCodexResetWatch(status, EXPIRES_MS - 1)?.windowText).toBe(
      'the next 6 hours'
    );
    expect(isCodexResetWatchExpired(status, EXPIRES_MS - 1)).toBe(false);
  });

  it('treats the expiry instant itself as expired', () => {
    expect(selectActiveCodexResetWatch(status, EXPIRES_MS)).toBeNull();
    expect(isCodexResetWatchExpired(status, EXPIRES_MS)).toBe(true);
  });

  it('reports neither active nor expired without a watch', () => {
    expect(selectActiveCodexResetWatch(null, EXPIRES_MS)).toBeNull();
    expect(
      isCodexResetWatchExpired({ watch: null, scheduledReset: null, latestReset: null }, EXPIRES_MS)
    ).toBe(false);
  });
});

describe('canShowCodexResetForecast', () => {
  it('shows on a first-party Codex provider', () => {
    expect(
      canShowCodexResetForecast({ cliType: 'builtin', agentType: 'codex', config: null })
    ).toBe(true);
    expect(
      canShowCodexResetForecast({
        cliType: 'builtin',
        agentType: 'codex',
        config: { brandId: undefined, env: {} },
      })
    ).toBe(true);
  });

  // The forecast is about OpenAI's own limits, so it must not follow a Codex
  // binary pointed at another vendor, nor any non-Codex provider.
  it.each([
    { cliType: 'builtin', agentType: 'claude', config: null },
    { cliType: 'custom', agentType: 'codex', config: null },
    { cliType: 'registry', agentType: 'codex', config: null },
    {
      cliType: 'builtin',
      agentType: 'codex',
      config: { brandId: undefined, env: { OPENAI_BASE_URL: 'https://example.invalid' } },
    },
  ] as const)('hides for %j', (input) => {
    expect(canShowCodexResetForecast(input)).toBe(false);
  });
});

describe('parseCacheControlMaxAgeMs', () => {
  it.each([
    ['public, max-age=14400, s-maxage=60, stale-while-revalidate=300', 14_400_000],
    ['max-age=60', 60_000],
    ['s-maxage=60', null],
    ['no-store', null],
    [null, null],
  ])('reads %j as %j', (header, expected) => {
    expect(parseCacheControlMaxAgeMs(header)).toBe(expected);
  });
});

describe('fetchCodexResetStatus', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stubFetch = (init: {
    status: number;
    body?: unknown;
    headers?: Record<string, string>;
  }) => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(init.body === undefined ? null : JSON.stringify(init.body), {
          status: init.status,
          headers: init.headers,
        })
      )
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  it('sends no credentials and no conditional header on a cold read', async () => {
    const fetchMock = stubFetch({
      status: 200,
      body: watchResponse(),
      headers: {
        etag: 'W/"abc"',
        'cache-control': 'public, max-age=14400, s-maxage=60, stale-while-revalidate=300',
      },
    });

    const result = await fetchCodexResetStatus({ etag: null });

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(CODEX_RESETS_STATUS_URL);
    expect(options.credentials).toBe('omit');
    expect(options.headers).not.toHaveProperty('if-none-match');
    expect(result.etag).toBe('W/"abc"');
    expect(result.maxAgeMs).toBe(14_400_000);
    expect(result.status?.watch?.chancePercent).toBe(65);
  });

  it('revalidates with If-None-Match and reports a 304 as unchanged', async () => {
    const fetchMock = stubFetch({
      status: 304,
      headers: { 'cache-control': 'public, max-age=14400' },
    });

    const result = await fetchCodexResetStatus({ etag: 'W/"abc"' });

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(options.headers).toMatchObject({ 'if-none-match': 'W/"abc"' });
    // A 304 carries no ETag header of its own here; the caller's is kept.
    expect(result).toEqual({ status: null, etag: 'W/"abc"', maxAgeMs: 14_400_000 });
  });

  it('rejects on an error status', async () => {
    stubFetch({ status: 429, body: { title: 'Too many requests' } });

    await expect(fetchCodexResetStatus({ etag: null })).rejects.toThrow('HTTP 429');
  });

  it('rejects a response shape it does not recognize', async () => {
    stubFetch({ status: 200, body: { nope: true } });

    await expect(fetchCodexResetStatus({ etag: null })).rejects.toThrow('expected shape');
  });
});

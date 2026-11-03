import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CODEX_RESETS_STATUS_URL,
  fetchCodexResetStatus,
  formatCodexResetExpiry,
  isCodexResetWatchExpired,
  parseCodexResetStatusResponse,
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
});

describe('parseCodexResetStatusResponse', () => {
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
});

describe('selectActiveCodexResetWatch', () => {
  const status = parseCodexResetStatusResponse(watchResponse());

  it('treats the expiry instant itself as expired', () => {
    expect(selectActiveCodexResetWatch(status, EXPIRES_MS)).toBeNull();
    expect(isCodexResetWatchExpired(status, EXPIRES_MS)).toBe(true);
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
});

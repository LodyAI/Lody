import { describe, expect, it } from 'vitest';

import {
  classifyFailureReason,
  describeChatFailure,
  parseFailureResetAt,
  redactFailureDetail,
} from '../src/session-failure';

describe('session failure normalization', () => {
  it('separates a provider usage window from context overflow', () => {
    expect(
      classifyFailureReason({
        reason: 'acp_upstream_api_error',
        message: "You've hit your 5-hour limit · resets 6am (UTC)",
      })
    ).toBe('usage_limit');
    expect(
      classifyFailureReason({
        reason: 'acp_internal_error',
        message: 'API Error: 400 prompt is too long: maximum context length is 200000 tokens',
      })
    ).toBe('context_overflow');
  });

  it('reports the next reset for a usage-limit notice', () => {
    const at = '2026-11-03T20:15:00.000Z';
    expect(
      describeChatFailure(
        {
          reason: 'acp_upstream_api_error',
          message: "You've hit your 5-hour limit · resets 6am (UTC)",
          at,
        },
        Date.parse(at)
      )
    ).toEqual({
      reason: 'usage_limit',
      retryable: true,
      detail: "You've hit your 5-hour limit · resets 6am (UTC)",
      resetAt: '2026-11-04T06:00:00.000Z',
      at,
    });
  });

  it('parses a clock reset only when the notice names UTC or GMT', () => {
    expect(parseFailureResetAt("You've hit your 5-hour limit · resets 6am (UTC)", 0)).toBe(
      '1970-01-01T06:00:00.000Z'
    );
    expect(
      parseFailureResetAt("You've hit your 5-hour limit · resets 3pm (Asia/Shanghai)", 0)
    ).toBe(undefined);
    expect(parseFailureResetAt('You can try again at 7:20 AM.', 0)).toBeUndefined();
    expect(parseFailureResetAt('The agent stopped without an explanation.', 0)).toBeUndefined();
  });

  it('redacts credentials and bounds provider text', () => {
    const detail = redactFailureDetail(
      'Authorization: Bearer synthetic-bearer-value API_KEY=synthetic-env-value ' + 'x'.repeat(700)
    );
    expect(detail).not.toContain('synthetic-bearer-value');
    expect(detail).not.toContain('synthetic-env-value');
    expect(Array.from(detail)).toHaveLength(500);
  });
});

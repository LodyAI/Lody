import { describe, expect, it } from 'vitest';
import type { MessageContent } from '@lody/shared';

import { resolvePermissionRecord } from '../src/components/ai-gui/permission-record';

type PermissionRequest = NonNullable<
  Extract<MessageContent, { type: 'tool_call' }>['permissionRequest']
>;

const request = (overrides: Partial<PermissionRequest> = {}): PermissionRequest =>
  ({
    requestId: 'req-1',
    options: [
      { optionId: 'allow', name: 'Yes, implement the plan', kind: 'allow_once' },
      { optionId: 'deny', name: 'No, and tell Codex what to change', kind: 'reject_once' },
    ],
    ...overrides,
  }) as PermissionRequest;

describe('resolvePermissionRecord', () => {
  it('keeps an unanswered request actionable', () => {
    expect(resolvePermissionRecord(request())).toEqual({ kind: 'pending' });
  });

  it('collapses an answered request to the option that was chosen', () => {
    expect(
      resolvePermissionRecord(request({ outcome: { outcome: 'selected', optionId: 'allow' } }))
    ).toEqual({ kind: 'settled', allowed: true, optionName: 'Yes, implement the plan' });

    expect(
      resolvePermissionRecord(request({ outcome: { outcome: 'selected', optionId: 'deny' } }))
    ).toEqual({
      kind: 'settled',
      allowed: false,
      optionName: 'No, and tell Codex what to change',
    });
  });

  it('shows nothing for a request that was withdrawn before anyone answered', () => {
    expect(resolvePermissionRecord(request({ outcome: { outcome: 'cancelled' } }))).toEqual({
      kind: 'withdrawn',
    });
  });

  it('falls back to generic approval copy when the chosen option is gone', () => {
    // Stale history: the recorded id no longer matches an offered option.
    expect(
      resolvePermissionRecord(request({ outcome: { outcome: 'selected', optionId: 'vanished' } }))
    ).toEqual({ kind: 'settled', allowed: true, optionName: null });

    // A blank name is not a label either.
    expect(
      resolvePermissionRecord(
        request({
          options: [{ optionId: 'allow', name: '   ', kind: 'allow_once' }],
          outcome: { outcome: 'selected', optionId: 'allow' },
        })
      )
    ).toEqual({ kind: 'settled', allowed: true, optionName: null });
  });
});

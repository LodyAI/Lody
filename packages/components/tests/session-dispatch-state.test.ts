import { describe, expect, it } from 'vitest';
import {
  hasUnstartedTrailingUserTurn,
  isUnstartedTrailingDispatchPreStart,
  UNSTARTED_TRAILING_USER_TURN_TIMEOUT_MS,
} from '../src/lib/session-dispatch-state';
import {
  shouldRequestNativeQueueSteer,
  shouldShowQueuedItemSteer,
} from '../src/components/sessions/message-queue/queued-message-steer';
import type { SessionInputBlock, MessageContent } from '@lody/shared';
import {
  buildResendInputBlocks,
  isUndeliveredUserTurnEntry,
} from '../src/lib/undelivered-user-turn';
import { resolvePermissionRecord } from '../src/components/ai-gui/permission-record';

describe('session-dispatch-state', () => {
  const userTurn = (status?: string, read?: boolean) => ({
    role: 'user' as const,
    ...(status !== undefined ? { status: status as never } : {}),
    ...(read !== undefined ? { read } : {}),
  });

  const userTurnAt = (timestamp: string, status = 'pending') => ({
    role: 'user' as const,
    status: status as never,
    timestamp,
  });

  const assistantTurn = () => ({ role: 'assistant' as const });

  describe('hasUnstartedTrailingUserTurn', () => {
    it('maps legacy read=false to pending', () => {
      expect(hasUnstartedTrailingUserTurn([userTurn(undefined, false)])).toBe(true);
    });

    it('stops reporting once the CLI takes ownership (processing)', () => {
      expect(hasUnstartedTrailingUserTurn([userTurn('processing')])).toBe(false);
    });

    it('ignores steer-owned pending_apply guides', () => {
      expect(hasUnstartedTrailingUserTurn([userTurn('pending_apply')])).toBe(false);
    });

    it('ignores pending user turns that are no longer trailing', () => {
      // A completed conversation always ends with an assistant/terminal entry;
      // an older stuck 'pending' entry must not resurrect the starting label.
      expect(hasUnstartedTrailingUserTurn([userTurn('pending'), assistantTurn()])).toBe(false);
    });
  });

  describe('isUnstartedTrailingDispatchPreStart', () => {
    const dispatchedAt = Date.parse('2026-07-23T00:00:00.000Z');

    it('is optimistic within the timeout window', () => {
      const now = dispatchedAt + UNSTARTED_TRAILING_USER_TURN_TIMEOUT_MS - 1;
      expect(
        isUnstartedTrailingDispatchPreStart([userTurnAt('2026-07-23T00:00:00.000Z')], now)
      ).toBe(true);
    });

    it('expires once the timeout elapses without CLI presence (no longer sticks)', () => {
      const now = dispatchedAt + UNSTARTED_TRAILING_USER_TURN_TIMEOUT_MS + 1;
      expect(
        isUnstartedTrailingDispatchPreStart([userTurnAt('2026-07-23T00:00:00.000Z')], now)
      ).toBe(false);
    });

    it('never shows pre-start for a turn without a usable timestamp', () => {
      expect(isUnstartedTrailingDispatchPreStart([userTurn('pending')], dispatchedAt)).toBe(false);
    });
  });
});

describe('queued-message-steer', () => {
  describe('shouldRequestNativeQueueSteer', () => {
    it.each([
      ['authoritative', { acknowledgedSteer: true }, true],
      ['authoritative', { acknowledgedSteer: false }, false],
      ['authoritative', undefined, false],
      ['provisional', { acknowledgedSteer: true }, false],
      ['unavailable', { acknowledgedSteer: true }, false],
    ] as const)(
      'routes %s capability %o to native steer: %s',
      (authority, capability, expected) => {
        expect(shouldRequestNativeQueueSteer(authority, capability)).toBe(expected);
      }
    );
  });

  describe('shouldShowQueuedItemSteer', () => {
    it.each([
      ['first row, native available', { isFirst: true, nativeSteerAvailable: true }, true],
      ['first row, native unavailable', { isFirst: true, nativeSteerAvailable: false }, true],
      ['later row, native available', { isFirst: false, nativeSteerAvailable: true }, true],
      ['later row, native unavailable', { isFirst: false, nativeSteerAvailable: false }, false],
    ] as const)('shows steer for %s: %s', (_label, row, expected) => {
      expect(shouldShowQueuedItemSteer({ showSteerAction: true, ...row })).toBe(expected);
    });
  });
});

describe('undelivered-user-turn', () => {
  const FILE_BLOCK: SessionInputBlock = {
    type: 'file',
    fileId: 'file-1',
    fileName: 'report.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 1024,
    sha256: 'deadbeef',
    textPreview: false,
    transport: 'r2',
    uploadedAt: 1_760_000_000_000,
  };

  const userTurn = (
    overrides: Partial<{
      id: string;
      role: 'user';
      read: boolean;
      status: 'pending' | 'handled' | 'failed' | 'canceled';
    }> = {}
  ) => ({
    id: 'turn-1',
    role: 'user' as const,
    read: false,
    status: 'pending' as const,
    ...overrides,
  });

  describe('isUndeliveredUserTurnEntry', () => {
    it('fires only for the exact non-terminal user entry the marker names', () => {
      expect(isUndeliveredUserTurnEntry('turn-1', userTurn())).toBe(true);
      // A marker naming a different turn must not leak onto this row.
      expect(isUndeliveredUserTurnEntry('turn-1', userTurn({ id: 'turn-2' }))).toBe(false);
      // No marker, no derivation.
      expect(isUndeliveredUserTurnEntry(undefined, userTurn())).toBe(false);
      // Only user entries carry the delivery state.
      expect(
        isUndeliveredUserTurnEntry('turn-1', { ...userTurn(), role: 'assistant' as never })
      ).toBe(false);
    });

    it('keeps older failed messages visible after a later timeout replaces the legacy marker', () => {
      expect(isUndeliveredUserTurnEntry('new-failure', userTurn(), { 'turn-1': true })).toBe(true);
      expect(isUndeliveredUserTurnEntry(undefined, userTurn(), { 'turn-1': true })).toBe(true);
      expect(
        isUndeliveredUserTurnEntry('new-failure', userTurn({ status: 'handled' }), {
          'turn-1': true,
        })
      ).toBe(false);
      expect(
        isUndeliveredUserTurnEntry('new-failure', userTurn({ id: 'fresh' }), { 'turn-1': true })
      ).toBe(false);
    });

    it('treats a legacy read=false entry without a status field as pending', () => {
      expect(
        isUndeliveredUserTurnEntry('turn-1', { id: 'turn-1', role: 'user' as const, read: false })
      ).toBe(true);
    });
  });

  describe('buildResendInputBlocks', () => {
    it('reuses the canonical inputConfig blocks verbatim, attachments included', () => {
      const blocks = buildResendInputBlocks({
        items: [{ type: 'text', text: 'rendered text' }],
        inputConfig: {
          prompt: 'rendered text',
          inputBlocks: [{ type: 'text', text: 'look at this' }, FILE_BLOCK],
        },
      });
      expect(blocks).toEqual([{ type: 'text', text: 'look at this' }, FILE_BLOCK]);
    });

    it('falls back to the rendered history items when no inputConfig blocks exist', () => {
      const blocks = buildResendInputBlocks({
        items: [{ type: 'text', text: '  rendered text  ' }],
        inputConfig: undefined,
      });
      expect(blocks).toEqual([{ type: 'text', text: 'rendered text' }]);
    });
  });
});

describe('permission-record', () => {
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
});

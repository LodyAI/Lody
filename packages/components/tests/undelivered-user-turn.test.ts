import { describe, expect, it } from 'vitest';
import type { SessionInputBlock } from '@lody/shared';

import {
  buildResendInputBlocks,
  isUndeliveredUserTurnEntry,
} from '../src/lib/undelivered-user-turn';

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
      isUndeliveredUserTurnEntry('new-failure', userTurn({ status: 'handled' }), { 'turn-1': true })
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

import { describe, expect, it } from 'vitest';
import {
  getLoroStreamIdForDocId,
  getSessionIdFromRoomId,
  isSessionDocRoomId,
  type WorkspaceId,
} from '../src';

describe('Session room ids', () => {
  it('keeps removed Session comment rooms out of the Session namespace', () => {
    expect(isSessionDocRoomId('session-comment-abc')).toBe(false);
    expect(getSessionIdFromRoomId('session-comment-abc')).toBeNull();
    expect(getLoroStreamIdForDocId('workspace' as WorkspaceId, 'session-comment-abc')).toBe(
      'session-comment-abc'
    );
  });
});

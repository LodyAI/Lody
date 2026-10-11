import { describe, expect, it } from 'vitest';
import type { SessionStatus } from '@lody/shared';
import { isSessionFinalizing } from '../src/components/sessions/session-chat-interface';

describe('isSessionFinalizing', () => {
  it('recognizes an explicitly reported finalization', () => {
    expect(isSessionFinalizing({ type: 'running', phase: 'finalizing' })).toBe(true);
  });

  it.each<SessionStatus | null | undefined>([
    undefined,
    null,
    { type: 'idle' },
    { type: 'running' },
    { type: 'running', activity: 'image_generation' },
    { type: 'initializing' },
    { type: 'requestPermission' },
  ])('does not label other live presence as finalizing: %j', (status) => {
    expect(isSessionFinalizing(status)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import type { SessionStatus } from '@lody/shared';
import { shouldHideThinkingDuringFinalization } from '../src/lib/agent-activity-visibility';

describe('shouldHideThinkingDuringFinalization', () => {
  it('hides thinking only during an explicitly reported finalization', () => {
    expect(shouldHideThinkingDuringFinalization({ type: 'running', phase: 'finalizing' })).toBe(
      true
    );
  });

  it.each<SessionStatus | null | undefined>([
    undefined,
    null,
    { type: 'idle' },
    { type: 'running' },
    { type: 'running', activity: 'image_generation' },
    { type: 'initializing' },
    { type: 'requestPermission' },
  ])('honors live activity without inferring completion from history: %j', (status) => {
    expect(shouldHideThinkingDuringFinalization(status)).toBe(false);
  });
});

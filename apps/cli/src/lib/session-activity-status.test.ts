import { describe, expect, it } from 'vitest';
import { SessionStatusFactory } from '@lody/shared';

import {
  resolveImageGenerationPresencePhase,
  shouldRestoreRunningAfterPermission,
} from './session-activity-status';

describe('resolveImageGenerationPresencePhase', () => {
  it('marks image generation while the turn is thinking', () => {
    expect(
      resolveImageGenerationPresencePhase({
        hasActiveImageGeneration: true,
        current: SessionStatusFactory.running(),
      })
    ).toBe('image_generation');
  });

  it('does not retarget missing, initializing, or permission presence', () => {
    expect(
      resolveImageGenerationPresencePhase({
        hasActiveImageGeneration: true,
        current: null,
      })
    ).toBeNull();
    expect(
      resolveImageGenerationPresencePhase({
        hasActiveImageGeneration: true,
        current: SessionStatusFactory.initializing(),
      })
    ).toBeNull();
    expect(
      resolveImageGenerationPresencePhase({
        hasActiveImageGeneration: true,
        current: SessionStatusFactory.requestPermission(),
      })
    ).toBeNull();
  });

  it('does not retarget finalizing presence', () => {
    expect(
      resolveImageGenerationPresencePhase({
        hasActiveImageGeneration: true,
        current: { type: 'running', phase: 'finalizing' },
      })
    ).toBeNull();
    expect(
      resolveImageGenerationPresencePhase({
        hasActiveImageGeneration: false,
        current: { type: 'running', phase: 'finalizing' },
      })
    ).toBeNull();
  });

  it('restores thinking only from the image-generation activity', () => {
    expect(
      resolveImageGenerationPresencePhase({
        hasActiveImageGeneration: false,
        current: SessionStatusFactory.running('image_generation'),
      })
    ).toBe('thinking');
    expect(
      resolveImageGenerationPresencePhase({
        hasActiveImageGeneration: false,
        current: SessionStatusFactory.running(),
      })
    ).toBeNull();
  });
});

describe('shouldRestoreRunningAfterPermission', () => {
  it('restores running while active presence is live', () => {
    expect(
      shouldRestoreRunningAfterPermission({
        hasActivePresence: true,
        status: SessionStatusFactory.requestPermission(),
      })
    ).toBe(true);
    expect(
      shouldRestoreRunningAfterPermission({
        hasActivePresence: true,
        status: SessionStatusFactory.running(),
      })
    ).toBe(true);
  });

  it('never restores running without active presence', () => {
    // Permission resolution arrives via a mirror subscription and can fire
    // after the turn ended (e.g. cancelled or crashed while waiting).
    expect(
      shouldRestoreRunningAfterPermission({
        hasActivePresence: false,
        status: SessionStatusFactory.requestPermission(),
      })
    ).toBe(false);
    expect(
      shouldRestoreRunningAfterPermission({
        hasActivePresence: false,
        status: 'unknown',
      })
    ).toBe(false);
  });

  it('does not resurrect an idle session', () => {
    expect(
      shouldRestoreRunningAfterPermission({
        hasActivePresence: true,
        status: SessionStatusFactory.idle(),
      })
    ).toBe(false);
    expect(
      shouldRestoreRunningAfterPermission({
        hasActivePresence: true,
        status: undefined,
      })
    ).toBe(false);
  });

  it('defaults to restoring when the doc cannot report a status', () => {
    expect(
      shouldRestoreRunningAfterPermission({
        hasActivePresence: true,
        status: 'unknown',
      })
    ).toBe(true);
  });
});

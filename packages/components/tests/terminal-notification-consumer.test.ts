import { describe, expect, it, afterEach, vi } from 'vitest';
import type { SessionId } from '@lody/shared';
import { createTerminalNotificationConsumer } from '../src/lib/terminal-notification-consumer';
import { applyKeyboardSelection } from '../src/components/terminal/terminal-keyboard-selection';
import {
  TERMINAL_PREVIEW_MAX_BYTES,
  prepareTerminalOutputBlocksPreview,
  prepareTerminalPreview,
} from '../src/components/ai-gui/terminal-preview';
import {
  copyShortcutBinding,
  isCopyShortcut,
  isPasteShortcut,
  usesWindowsCopyPasteRightClick,
} from '../src/components/terminal/terminal-clipboard-shortcuts';
import { __resetPlatformCacheForTests } from '../src/lib/commands/platform';

describe('terminal-notification-consumer', () => {
  const sessionId = 'session-1' as SessionId;
  const first = 'a42f1111-1111-4111-8111-111111111111';
  const second = 'a42f1111-1111-4111-8111-222222222222';
  const fact = {
    id: first,
    turnId: 'turn-1',
    recipientId: 'user-1',
    outcome: 'failed',
    createdAt: 100,
  };
  function setup(read: () => Promise<unknown> = async () => fact) {
    const shown: string[] = [];
    const errors: unknown[] = [];
    const consumer = createTerminalNotificationConsumer({
      recipientId: 'user-1',
      now: () => 200,
      read,
      show: async (_, notification) => {
        shown.push(notification.outcome);
      },
      onError: (error) => {
        errors.push(error);
      },
    });
    return { consumer, shown, errors };
  }
  describe('desktop terminal consumer', () => {
    it('baselines startup and new/restored rows, consumes changed sources once', async () => {
      const { consumer, shown } = setup();
      await consumer.observe([{ id: sessionId }]);
      await consumer.observe([{ id: sessionId, notificationId: first }]);
      await consumer.observe([{ id: sessionId, notificationId: first }]);
      expect(shown).toEqual(['failed']);
      await consumer.observe([]);
      await consumer.observe([{ id: sessionId, notificationId: first }]);
      expect(shown).toEqual(['failed']);
      consumer.dispose();
      const restart = setup();
      await restart.consumer.observe([{ id: sessionId, notificationId: first }]);
      expect(restart.shown).toEqual([]);
      restart.consumer.dispose();
    });

    it.each([
      { ...fact, recipientId: 'someone-else' },
      { ...fact, id: second },
      { ...fact, outcome: 'cancelled' },
      { ...fact, createdAt: -60_000 },
      { ...fact, createdAt: 300 },
      undefined,
    ])('skips unauthorized, stale, malformed or mismatched projections', async (value) => {
      const { consumer, shown } = setup(async () => value);
      await consumer.observe([{ id: sessionId }]);
      await consumer.observe([{ id: sessionId, notificationId: first }]);
      expect(shown).toEqual([]);
      consumer.dispose();
    });

    it('fences an in-flight read on account/workspace teardown', async () => {
      let release!: (value: unknown) => void;
      const { consumer, shown } = setup(
        () =>
          new Promise((resolve) => {
            release = resolve;
          })
      );
      await consumer.observe([{ id: sessionId }]);
      const attempt = consumer.observe([{ id: sessionId, notificationId: first }]);
      consumer.dispose();
      release(fact);
      await attempt;
      expect(shown).toEqual([]);
    });
  });
});

describe('terminal-keyboard-selection', () => {
  function select(input: Parameters<typeof applyKeyboardSelection>[0]) {
    return applyKeyboardSelection(input);
  }

  describe('applyKeyboardSelection', () => {
    it('ignores a stale keyboard session when the xterm selection moved', () => {
      expect(
        select({
          key: 'ArrowRight',
          cols: 80,
          lineCount: 24,
          cursor: { x: 0, y: 10 },
          anchor: { x: 5, y: 2 },
          head: { x: 8, y: 2 },
          existing: { start: { x: 10, y: 5 }, end: { x: 14, y: 5 } },
        })
      ).toEqual({
        start: { x: 10, y: 5 },
        length: 5,
        anchor: { x: 10, y: 5 },
        head: { x: 15, y: 5 },
      });
    });

    it('starts from the cursor when a cached session no longer has an xterm selection', () => {
      expect(
        select({
          key: 'ArrowRight',
          cols: 80,
          lineCount: 24,
          cursor: { x: 3, y: 7 },
          anchor: { x: 5, y: 2 },
          head: { x: 8, y: 2 },
          existing: null,
        })
      ).toEqual({
        start: { x: 3, y: 7 },
        length: 1,
        anchor: { x: 3, y: 7 },
        head: { x: 4, y: 7 },
      });
    });
  });

  function keyEvent(init: Partial<KeyboardEvent> & Pick<KeyboardEvent, 'key'>): KeyboardEvent {
    return {
      type: 'keydown',
      shiftKey: false,
      altKey: false,
      metaKey: false,
      ctrlKey: false,
      ...init,
    } as KeyboardEvent;
  }
});

describe('terminal-preview', () => {
  describe('prepareTerminalPreview', () => {
    it('does not return an oversized legacy line to ANSI or the DOM', () => {
      const preview = prepareTerminalPreview('x'.repeat(1024 * 1024));

      expect(preview.wasLimited).toBe(true);
      expect(preview.omittedLongLine).toBe(true);
      expect(preview.text).toContain('omitted');
      expect(preview.text.length).toBeLessThan(256);
    });

    it('keeps a bounded tail from the final adjacent terminal block', () => {
      const preview = prepareTerminalOutputBlocksPreview([
        { output: 'old output\n'.repeat(10_000) },
        { output: 'final diagnostic' },
      ]);

      expect(preview.text).toContain('final diagnostic');
      expect(new TextEncoder().encode(preview.text).byteLength).toBeLessThanOrEqual(
        TERMINAL_PREVIEW_MAX_BYTES
      );
    });
  });
});

describe('terminal-clipboard-shortcuts', () => {
  function keyEvent(init: Partial<KeyboardEvent> & Pick<KeyboardEvent, 'key'>): KeyboardEvent {
    return {
      type: 'keydown',
      shiftKey: false,
      altKey: false,
      metaKey: false,
      ctrlKey: false,
      code: '',
      ...init,
    } as KeyboardEvent;
  }

  function stubPlatform(os: 'win32' | 'darwin' | 'linux'): void {
    vi.stubGlobal('window', { __LODY_PLATFORM__: { os } });
    __resetPlatformCacheForTests();
  }

  describe('terminal clipboard shortcuts', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      __resetPlatformCacheForTests();
    });

    it('on Windows copies with Ctrl+C only when text is selected', () => {
      stubPlatform('win32');
      expect(isCopyShortcut(keyEvent({ key: 'c', code: 'KeyC', ctrlKey: true }), true)).toBe(true);
      expect(isCopyShortcut(keyEvent({ key: 'c', code: 'KeyC', ctrlKey: true }), false)).toBe(
        false
      );
      expect(copyShortcutBinding()).toBe('ctrl+c');
      expect(usesWindowsCopyPasteRightClick()).toBe(true);
    });

    it('on Linux keeps Ctrl+V for the shell and pastes with Ctrl+Shift+V', () => {
      stubPlatform('linux');
      expect(isPasteShortcut(keyEvent({ key: 'v', code: 'KeyV', ctrlKey: true }))).toBe(false);
      expect(
        isPasteShortcut(keyEvent({ key: 'v', code: 'KeyV', ctrlKey: true, shiftKey: true }))
      ).toBe(true);
      expect(isCopyShortcut(keyEvent({ key: 'c', code: 'KeyC', ctrlKey: true }), true)).toBe(false);
      expect(copyShortcutBinding()).toBe('ctrl+shift+c');
      expect(usesWindowsCopyPasteRightClick()).toBe(false);
    });
  });
});

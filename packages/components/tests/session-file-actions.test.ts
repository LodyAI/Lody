import { describe, expect, it } from 'vitest';
import {
  normalizeSessionFileActionPlatform,
  resolveOpenFileLabel,
  resolveOpenFileTarget,
  resolveRevealFileLabel,
  resolveSessionFileActionAvailability,
} from '../src/lib/session-file-actions';

const t = (_key: string, fallback: string) => fallback;

describe('session file actions', () => {
  it('names the file manager the way the host OS does', () => {
    expect(resolveRevealFileLabel('darwin', t)).toBe('Show in Finder');
    expect(resolveRevealFileLabel('win32', t)).toBe('Show in File Explorer');
    expect(resolveRevealFileLabel('linux', t)).toBe('Reveal in file manager');
    expect(resolveRevealFileLabel(normalizeSessionFileActionPlatform(undefined), t)).toBe(
      'Reveal in file manager'
    );
  });

  it('only promises a browser for a file a browser really handles', () => {
    expect(resolveOpenFileTarget('reports/T7112.html')).toBe('browser');
    expect(resolveOpenFileLabel('reports/T7112.HTM', t)).toBe('Open in browser');
    expect(resolveOpenFileLabel('src/main.ts', t)).toBe('Open in default app');
  });

  describe('availability', () => {
    const availability = (
      overrides: Partial<Parameters<typeof resolveSessionFileActionAvailability>[0]>
    ) =>
      resolveSessionFileActionAvailability({
        isElectronRenderer: true,
        isLocalMachine: true,
        hasHostPath: true,
        hasFileProvider: true,
        ...overrides,
      });

    it('reaches the shell only in the desktop app with the file on this machine', () => {
      expect(availability({}).localHost).toBe(true);
      expect(availability({ isElectronRenderer: false }).localHost).toBe(false);
      expect(availability({ isLocalMachine: false }).localHost).toBe(false);
      // Without a resolved absolute path there is nothing to hand the OS.
      expect(availability({ hasHostPath: false }).localHost).toBe(false);
    });

    it('offers the download exactly where the shell actions are missing', () => {
      // With the real file one keystroke away, a copy in ~/Downloads is a decoy.
      expect(availability({}).download).toBe(false);
      expect(availability({ isElectronRenderer: false }).download).toBe(true);
      expect(availability({ isLocalMachine: false }).download).toBe(true);
      // ...but only when something can actually read the bytes.
      expect(availability({ isLocalMachine: false, hasFileProvider: false }).download).toBe(false);
    });
  });
});

import { it, expect, vi } from 'vitest';
import { Result } from 'effect';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodePairingSecret, formatPairingString } from '@lody/e2ee-core/protocol';

vi.mock('../../../apps/electron/src/main/window-state', () => ({
  getMainWindow: () => null,
  consumePendingDeepLink: () => null,
  setPendingDeepLink: () => {},
}));
vi.mock('../../../apps/electron/src/main/platform', () => ({
  desktopInstallationProfile: { desktopProtocol: 'lody' },
}));
vi.mock('../../../apps/electron/src/main/desktop-channel', () => ({
  getDesktopCallbackProtocol: () => 'lody-stable',
}));
vi.mock('../../../apps/electron/src/main/window', () => ({ focusMainWindow: () => {} }));
vi.mock('../../../apps/electron/src/main/services/desktop-login', () => ({
  readDesktopLoginCallback: () => null,
}));
vi.mock('../../../apps/electron/node_modules/electron', () => ({
  app: { whenReady: () => Promise.resolve(), getApplicationNameForProtocol: () => false },
  dialog: { showMessageBox: () => Promise.resolve({ response: 0 }) },
  shell: {},
}));
import { describeDeepLinkForAuthDebug } from '../../../apps/electron/src/main/auth-debug';
import { handleDeepLink } from '../../../apps/electron/src/main/deep-link';
import {
  createDesktopLog,
  mirrorConsoleToDesktopLog,
} from '../../../apps/electron/src/main/desktop-log-core';

// Desktop URL diagnostics retain only fixed route names and structural metadata.
it('keeps rejected URL diagnostics within the fixed metadata schema', () => {
  const code = Result.getOrThrow(encodePairingSecret(new Uint8Array(16).fill(0x12)));
  const url = `lody://pair/${code}`;
  const logDir = mkdtempSync(join(tmpdir(), 'd8-synthetic-desktop-log-'));
  const log = createDesktopLog({
    logDir,
    scopePrefix: 'desktop:synthetic',
    scheduleFlush: () => {},
  });
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  const restore = mirrorConsoleToDesktopLog(console, log);
  try {
    handleDeepLink(url);
    log.flushSync();
    const files = readdirSync(logDir).filter((name) => name.endsWith('.log'));
    const retained = files.map((name) => readFileSync(join(logDir, name), 'utf8')).join('');
    expect(retained.includes(code)).toBe(false);
    expect(retained.includes('[INFO]')).toBe(true);
    expect(retained.includes('pathname')).toBe(false);
    for (const url of [
      `lody://${code}/`,
      `lody://chat/new?${code}=1#${code}=2`,
      `https://${code}.invalid/${code}`,
      // A new computer's approval link carries its comparison code.
      `lody://auto-pair?id=${code}&code=${code}`,
    ]) {
      expect(JSON.stringify(describeDeepLinkForAuthDebug(url)).includes(code)).toBe(false);
    }
    // Ordinary inline pairing UI is not invoked by this diagnostic test.
    expect(formatPairingString(code).length).toBeGreaterThan(code.length);
    expect(statSync(join(logDir, files[0]!)).mode & 0o777).toBe(0o600);
  } finally {
    restore();
    info.mockRestore();
    rmSync(logDir, { recursive: true, force: true });
  }
});

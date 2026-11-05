import { describe, expect, it } from 'vitest';
import { shouldAttemptDesktopInviteHandoff } from '../src/lib/desktop-invite-deep-link';

describe('desktop invite handoff environment', () => {
  it('only attempts the handoff from a desktop browser', () => {
    expect(
      shouldAttemptDesktopInviteHandoff({
        isElectron: false,
        isNativeAppShell: false,
        isIOSRuntime: false,
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      })
    ).toBe(true);

    expect(
      shouldAttemptDesktopInviteHandoff({
        isElectron: true,
        isNativeAppShell: false,
        isIOSRuntime: false,
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      })
    ).toBe(false);
    expect(
      shouldAttemptDesktopInviteHandoff({
        isElectron: false,
        isNativeAppShell: true,
        isIOSRuntime: true,
        userAgent: 'Mozilla/5.0 (iPhone)',
      })
    ).toBe(false);
    expect(
      shouldAttemptDesktopInviteHandoff({
        isElectron: false,
        isNativeAppShell: false,
        isIOSRuntime: false,
        userAgent: 'Mozilla/5.0 (Linux; Android 15)',
      })
    ).toBe(false);
    expect(
      shouldAttemptDesktopInviteHandoff({
        isElectron: false,
        isNativeAppShell: false,
        isIOSRuntime: true,
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      })
    ).toBe(false);
  });
});

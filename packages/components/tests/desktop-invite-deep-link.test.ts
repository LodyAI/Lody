import { describe, expect, it } from 'vitest';
import { shouldAttemptDesktopInviteHandoff } from '../src/lib/desktop-invite-deep-link';
import { resolveDesktopCheckoutReturnDeepLinkPath } from '../src/lib/desktop-checkout-return-deep-link';
import { resolveDesktopOpenLocalProjectDeepLinkPath } from '../src/lib/desktop-open-local-project-deep-link';

describe('desktop-invite-deep-link', () => {
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
});

describe('desktop-checkout-return-deep-link', () => {
  describe('resolveDesktopCheckoutReturnDeepLinkPath', () => {
    it('routes a successful checkout return to the billing tab with the success marker', () => {
      expect(
        resolveDesktopCheckoutReturnDeepLinkPath(
          'lody://checkout-return?workspaceSlug=acme&checkout=success'
        )
      ).toBe('/acme/settings/billing?checkout=success');
    });

    it('routes a canceled checkout return to the billing tab without the marker', () => {
      expect(
        resolveDesktopCheckoutReturnDeepLinkPath(
          'lody://checkout-return?workspaceSlug=acme&checkout=canceled'
        )
      ).toBe('/acme/settings/billing');
    });

    it('routes a portal return (no checkout param) to the billing tab', () => {
      expect(
        resolveDesktopCheckoutReturnDeepLinkPath('lody://checkout-return?workspaceSlug=acme')
      ).toBe('/acme/settings/billing');
    });

    it('falls back to the current path workspace slug when the link has none', () => {
      expect(
        resolveDesktopCheckoutReturnDeepLinkPath('lody://checkout-return', '/acme/sessions/s1')
      ).toBe('/acme/settings/billing');
    });

    it('returns null when no workspace slug can be resolved', () => {
      expect(resolveDesktopCheckoutReturnDeepLinkPath('lody://checkout-return', '/')).toBeNull();
    });
  });
});

describe('desktop-open-local-project-deep-link', () => {
  const MACHINE = 'machine-1';
  const PROJECT = 'local-project-abc123';

  describe('resolveDesktopOpenLocalProjectDeepLinkPath', () => {
    it('routes a `lody app` link to the new-chat landing with the local project preselected', () => {
      expect(
        resolveDesktopOpenLocalProjectDeepLinkPath(
          `lody://chat/new?machine=${MACHINE}&project=${PROJECT}&workspaceSlug=acme`
        )
      ).toBe(`/acme/chat?context=local&machine=${MACHINE}&project=${PROJECT}`);
    });

    it('falls back to the current path workspace slug when the link carries none', () => {
      expect(
        resolveDesktopOpenLocalProjectDeepLinkPath(
          `lody://chat/new?machine=${MACHINE}&project=${PROJECT}`,
          '/acme/sessions/s1'
        )
      ).toBe(`/acme/chat?context=local&machine=${MACHINE}&project=${PROJECT}`);
    });

    it('returns null when no workspace slug can be resolved', () => {
      expect(
        resolveDesktopOpenLocalProjectDeepLinkPath(
          `lody://chat/new?machine=${MACHINE}&project=${PROJECT}`,
          '/'
        )
      ).toBeNull();
    });

    it('carries no path parameter, so a link can never register a directory', () => {
      const path = resolveDesktopOpenLocalProjectDeepLinkPath(
        `lody://chat/new?machine=${MACHINE}&project=${PROJECT}&workspaceSlug=acme&path=${encodeURIComponent('/etc')}`
      );
      expect(path).toBe(`/acme/chat?context=local&machine=${MACHINE}&project=${PROJECT}`);
      expect(path).not.toContain('etc');
    });
  });
});

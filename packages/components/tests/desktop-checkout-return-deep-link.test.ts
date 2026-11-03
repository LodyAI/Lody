import { describe, expect, it } from 'vitest';
import { resolveDesktopCheckoutReturnDeepLinkPath } from '../src/lib/desktop-checkout-return-deep-link';

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

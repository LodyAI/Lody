# Keep the desktop settings modal on the URL tab during its redirect

Status: implemented
Translation: current
PR: [#1696](https://github.com/LodyAI/Lody/pull/1696)

[中文](2026-10-18-settings-modal-redirect-tab.zh.md)

## Abstract

After a successful subscription, the user returned to `/<slug>/settings/billing?checkout=success`
but the desktop settings modal opened on Account instead of Billing. On desktop widths (Web and
Electron), the settings route is only a trampoline: it opens the modal at the URL tab, then
replaces the URL with the opening page or chat. While that redirect is pending, TanStack Router
already reports the destination location to the still-mounted settings layout, so its effect ran
again with no tab, reset the modal to the default tab, cleared machine/project targets, and
redirected a second time without `from`. The effect now runs only while the location is a
settings path. Payment, return URLs, and checkout confirmation are unchanged.

## Evidence

- `router-core` sets `location` to the new location with `status: 'pending'` before the matches
  switch, so `useLocation()` in the outgoing layout returns `/<slug>/chat` for one render.
  `getActiveSettingsTabId` gives `null` for it, and `activeTabId ?? SETTINGS_DEFAULT_TAB` selected
  `account`.
- Both checkout return paths reach this layout: Stripe's web `successUrl` and the Electron
  `lody://checkout-return` deep link, resolved by `resolveDesktopCheckoutReturnDeepLinkPath`.
  Capacitor/mobile widths render the settings page and are not affected.
- The defect was not billing specific: any desktop settings deep link lost its tab and `from`.

## Decision

The guard uses the existing `isSettingsPath` helper. A run-once ref would also stop the reset,
but it would also ignore a real settings-tab change while the layout stays mounted. The billing
tab still observes `?checkout=success` on mount, so the per-tab confirmation from
[#1218](2026-10-02-billing-checkout-return-confirmation.md) continues to start.

## Verification and limits

`tests/settings-layout-desktop-redirect.test.tsx` mounts the real layout under a real router with
browser history. It covers the checkout return (Billing tab, marker seen by the tab) and a
`from` + machine-target return. Both fail before the fix. No live Stripe payment or packaged
Electron run was performed.

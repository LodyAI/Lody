# Local wallpaper for the new-conversation page

Status: implemented
Translation: current

[中文](2026-10-26-appearance-wallpaper.zh.md)

## Abstract

Lody's Appearance settings had no custom background image. The desktop
new-conversation page now supports a locally selected wallpaper with transparency,
blur, vignette and a live settings preview, using a downward fade inspired by
Zeron. Only the decorative image changes; existing text, composer elevation and
conversation backgrounds keep their theme materials. Images stay on the device;
this does not implement native desktop vibrancy, wallpaper rotation or Zeron's
image effects.

## Reference and decision

Inspected Zeron at `325384d8b1200630410580f179a7e7910c7ccb31`:

- [Image mask](https://github.com/zeronsh/zeron/blob/325384d8b1200630410580f179a7e7910c7ccb31/crates/ui/src/new_thread_background_mask.rs)
  uses cover fitting, a full-height bottom alpha fade, an 8px composer clearance,
  feathering clamped to 120–280px and a second reveal pass at 0.5 opacity.
- [Theme materials](https://github.com/zeronsh/zeron/blob/325384d8b1200630410580f179a7e7910c7ccb31/crates/ui/src/theme.rs)
  distinguish native window glass from in-app frosting. Native glass starts at
  0.80 coverage on macOS/Windows and remains opaque on Linux; contrast checking
  can raise coverage. Floating light frost uses 0.45 coverage. Selection uses
  inset edges rather than a dark drop-shadow plate behind translucent chips.
- [Appearance lifecycle](https://github.com/zeronsh/zeron/blob/325384d8b1200630410580f179a7e7910c7ccb31/crates/ui/src/appearance.rs)
  reapplies native background appearance separately from the theme palette.

Lody adapts the image/fade layering, not GPUI-specific native materials or source
code. Its composer is docked at the bottom, so a CSS alpha fade replaces Zeron's
measured composer cutout. Existing Lody card shadows remain intact; vignette is
an image adjustment, not a replacement for elevation shadows. The outer composer
dock opts into a transparent background while a wallpaper is selected: its normal
opaque fill otherwise cuts off the remaining image alpha at a full-width horizontal
edge. The input plate retains its own fill and shadow, and session docks retain
their opaque background. Defaults are 45%
transparency, no blur and 20% vignette. The feature is off until an image is chosen.

## Ownership and trade-offs

```text
Appearance settings → decode / resize → local preference atom → localStorage
                                             ↓
                         shared WallpaperBackdrop
                         ↙                    ↘
                    live preview       new-conversation page
```

The [settings README](../../../../packages/components/src/components/settings/README.md#wallpaper)
owns implementation details. A bounded encoded image keeps this preference
independent of workspace storage, uploads and Electron IPC. The trade-off is a
1920px longest edge and 1.4-million-character encoded limit, with synchronous
local preference writes. Failed decoding or persistence preserves the old image;
late decoding after settings unmount cannot publish. Unsupported remote URLs and
malformed persisted values normalize safely. No assets or code were copied from
Zeron and no additional dependency was introduced.

## Verification

Behavioral coverage extends the existing appearance suite for restoration,
adjustments, reset/removal, storage failure, invalid image selection and cross-window
updates. The appearance and landing submission suites pass all 15 tests. A Chromium
harness rendering the real `WebChatLandingScreen` also verifies a transparent
composer dock with wallpaper, continued typing, a short viewport, and restoration
of the opaque dock after removing the image. Its composer child is a synthetic
textarea; the actual dock, background and page layout are production components. A focused Chromium harness verified real
PNG upload/WebP encoding, preview, slider persistence, reload, reset/removal and
Chinese copy; light/dark rendering was visually inspected. The four new modules
pass an isolated TypeScript check; scoped Oxfmt/Oxlint, i18n and diff checks pass.
Full package typechecking remains blocked by missing Electron dependencies and
unrelated existing type errors in the reused dependency environment. `docs check`
reports existing links into uninitialized ACP submodules, with no errors in the
changed documents. Full Storybook startup did not complete its initial dependency
bundle in time; the browser harness exercised the real wallpaper components
instead. `pnpm format` completed before submission. The root `pnpm check` stopped at
site-docs pretypecheck because `fumadocs-mdx` is not installed in this checkout.
No full desktop build or full repository test run was completed.

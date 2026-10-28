# Preserve login label descenders

Status: implemented
Translation: current
PR: [#1879](https://github.com/LodyAI/Lody/pull/1879)

[中文](2026-10-25-login-label-clipping.zh.md)

## Abstract

The login method labels clipped the bottom of letters such as the “g” in Google.
Their ellipsis container inherited the Button's 13px line box while the rendered
text occupied 18px. Labels now use the existing subheadline leading token, giving
the glyphs room while retaining horizontal ellipsis and the 36px button height.

## Decision and evidence

The [login surface](../../../../packages/components/src/components/login-page.tsx)
owns the label's overflow and therefore its line height. This refines the label
layout in the [login visual decision](../feature/2026-10-17-login-inset-visual-last-used.md).
Changing the shared Button would affect unrelated controls; removing overflow
would lose truncation beside the last-used badge. The local label instead uses
`text.subheadlineLeading`, which follows the document font size.

Playwright with Chrome reproduced clipping before the fix in Chinese and English,
at 1280px and 390px viewport widths, in light and dark themes. In all eight cases,
the fixed Google button with its last-used badge renders identical pixels with
label clipping enabled and temporarily disabled. The label measures 18px and
the button remains 36px. Before/after screenshots also show the provider group.
These checks use synthetic Storybook state and do not exercise live sign-in.
Repository checks encounter unrelated ACP dependency resolution errors in the
reused installation; browser verification uses temporary local-source aliases.

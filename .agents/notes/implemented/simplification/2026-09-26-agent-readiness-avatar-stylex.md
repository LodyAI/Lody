# Use the readiness mark's StyleX avatar surface in onboarding

Status: implemented
Translation: current

[中文](2026-09-26-agent-readiness-avatar-stylex.zh.md)

## Abstract

The [readiness mark migration](2026-09-26-agent-readiness-stylex.md) moved the
component's visual rules to StyleX, but the onboarding caller still supplied a
Tailwind colour and radius override. This stack layer selects the mark's
`surface="avatar"` variant instead. A Storybook scene keeps the compact avatar
states visible during review.

## Decision

The mark owns both tile and avatar visual surfaces. Onboarding selects a
semantic variant rather than relying on the order in which Tailwind and StyleX
styles are injected. Its external `className` prop remains available for layout
composition, not this surface override.

## Verification

Playwright rendered the `AvatarSurface` story at 640 × 500 in light and dark
themes before and after this caller migration. The before fixture supplied the
original `rounded-full bg-muted/50` classes; the after fixture used
`surface="avatar"`. Fonts and viewport were fixed, reduced motion removed
animation phase variance, and both PNG pairs matched byte-for-byte. This
confirms the sampled visual states, not every host theme or device scale factor.

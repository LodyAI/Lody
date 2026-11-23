# Conversation font size picks from a fixed scale

Status: implemented
Translation: current

[中文](2026-09-14-conversation-font-size-scale.zh.md)

## Abstract

The conversation font size was a number field whose every keystroke was clamped into
9-32px and written back, so the field rewrote what the user was typing: aiming for 24
turned the first `2` into `9`, the next keystroke read `94`, and that landed on 32.
Emptying the field to start over did nothing, because a blank value parsed as NaN and
left the previous number in place. Settings now offers eight sizes — 8, 12, 14, 16, 20, 24, 28, 32 — through the same
picker the theme row uses on desktop and the inline picker on mobile, with a sample line
rendered at the selected size beneath the row, and the stored value snaps to the nearest
offered size instead of being clamped into a range. The trade-off is
deliberate: sizes between the steps are no longer reachable, and a user who had persisted
one (13px, say) moves to its nearest neighbour on first read.

## Decision and evidence

`normalizeConversationFontSize` was doing two different jobs under one name — migrating
the legacy `small`/`default`/`large` presets, and repairing whatever a live `onChange`
handed it. The second job is what made the field feel hostile: every keystroke went
through a clamp that both bounded and rounded, and the result was written straight back
into the controlled input. Removing free-form entry removes the need for that repair at
the input edge; the function keeps only the persistence job, where an unexpected stored
value still has to become something renderable.

Snapping to the nearest step (ties round up) is what that job becomes. Clamping to the
new minimum and maximum would have been simpler but loses information a user expressed:
a stored 13px means "smaller than default", and 12px preserves that where a clamp would
return it unchanged and then fail to match any offered option, leaving the picker with no
selection. `CONVERSATION_FONT_SIZES` is the single source for both the offered options and
the snap targets, so the two cannot drift.

The scale itself is coarse on purpose. 8-16 covers the sizes people actually read body
text at, in 2-4px steps that are distinguishable side by side; 20-32 exists for
accessibility and presentation, where a 2px step would be invisible. The old range
started at 9px; 8px is offered instead, because a scale reads better from a round number
and the difference is not perceptible.

A number is not a size, so each surface renders a sample sentence at the selected size
directly below the row — the same shape the Terminal section already uses for its font
preview. Desktop goes further by feeding `PreviewSelect`'s hover callback into local state
rather than the setting: hovering `24 px` redraws the sample at 24px while the saved value
and the trigger stay put, and closing the menu without choosing drops back. The sample uses
`conversationTextFontSizeStyle`, the same helper the conversation renderers use, so the
preview cannot drift from what the conversation actually does.

Both surfaces label options identically through `buildConversationFontSizeChoices`
(`14 px · Default`), so the desktop and mobile settings cannot describe the same stored
value differently. Desktop reuses `PreviewSelect` — the theme row's control — rather than
`OptionSelector`, because the row needs neither search nor virtualization for eight
options and the panel already reads as a column of matching 220px triggers.

The terminal font size in the same panel keeps its number field. Its range tops out at
24px, so this scale does not describe it, and its default (13px) is not on the scale;
giving it presets means choosing a second scale, which is a separate decision.

## Verification

`packages/components` typecheck, `pnpm lint`, and `pnpm lint:i18n` pass. The two owning
suites pass (11 tests): `tests/terminal-settings.test.ts` pins the offered scale and the
snapping of legacy presets, out-of-range values, and ties; `tests/appearance-settings.test.tsx`
drives the desktop picker through opening, the exact list of eight options, hover preview,
Escape restoring the saved size, and committing 24px, and asserts the mobile row has no
number field and renders its sample at the stored size. The new
`Mobile/MobileAppearanceSettings` story was read in a built Storybook at 8px/14px/32px, in
light, dark, and Chinese.

`Settings/AppearanceSettings` could not be read there: in a built Storybook it hangs in
Storybook's "preparing" state with no error, as does `Settings/BillingSettings`. Both reach
the settings barrel (`settings/index.tsx`), which every settings surface imports for
`settingContainerClass` and which therefore imports them all back; the resulting chunk
cycle deadlocks under `vite-plugin-top-level-await`. That predates this change and was left
alone. The desktop layout was instead read through a temporary Vite dev page rendering
`AppearanceSettingsView` directly, covering the default, an open menu with a hovered size,
a committed size, dark, and Chinese; the page was deleted afterwards.

The full repository suite was not run. No Spec covers appearance settings, so none was
updated.

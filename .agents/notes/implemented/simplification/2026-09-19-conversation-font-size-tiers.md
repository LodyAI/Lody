# Conversation font size named tiers

Status: implemented
Translation: current

[中文](2026-09-19-conversation-font-size-tiers.zh.md)

## Abstract

The conversation font size setting shrank from an eight-value pixel scale
(8–32px) to five named tiers — smaller, small, default, large, larger for
12–16px — because usable conversation sizes cluster inside that band and the
extremes read as defects rather than choices. The slider and the sample-text
preview are gone: named options state their intent, so no preview is needed to
explain a number. Desktop reuses the `PreviewSelect` pattern; mobile uses the
same inline picker as the language row, both fed by one shared label list.

## Decision

This supersedes the interaction from the
[slider note](../bug-fix/2026-09-15-conversation-font-size-slider.md) and
narrows the scale from the
[fixed-scale note](2026-09-14-conversation-font-size-scale.md): the eight pixel
values become five named tiers in `CONVERSATION_FONT_SIZES`, and
`conversation-font-size-options.ts` is the single label source so desktop and
mobile cannot describe the same stored size differently.

`normalizeConversationFontSize` keeps its persistence contract — persisted
numbers from older builds snap to the nearest offered tier (a saved 24 lands on
16, the closest remaining size), and legacy preset strings still migrate.
`ConversationFontSize` stays a number, so every consumer of the stored value is
unchanged.

Removing the preview and the helper text is deliberate: a named tier needs no
sample sentence, and the section stays a single row like Theme and Language.
Free-form numeric entry remains out — clamping a number input on each keystroke
breaks multi-digit editing, and the wide old range only offered unusable sizes.

## Verification

The appearance suite asserts the five labels in order and that picking one
commits it; the mobile suite covers both limits and persisted reload; the
normalization suite pins the new scale and snapping. Not exercised here:
packaged native-app checks.

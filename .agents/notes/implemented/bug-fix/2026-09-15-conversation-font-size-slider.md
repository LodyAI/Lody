# Conversation font size slider

Status: implemented
Translation: current

[中文](2026-09-15-conversation-font-size-slider.zh.md)

## Abstract

Conversation size adjustment needs a direct touch control without opening a keyboard
or a picker. Desktop and mobile now share a native range input, with a full-width
mobile row and a 44px touch area. The existing eight-size scale and sample text stay
intact; dragging commits each step immediately rather than previewing a menu option.

## Decision

This replaces only the picker interaction from the
[fixed-scale decision](../simplification/2026-09-14-conversation-font-size-scale.md).
The slider indexes `CONVERSATION_FONT_SIZES`, so adjacent thumb positions always
select an offered size despite unequal pixel intervals. Persisted values and legacy
normalization keep their existing contract. `aria-valuetext` announces pixels rather
than the index. The visible readout and the existing sample update from the same value.

The browser owns touch, pointer, and keyboard handling. The mobile track starts beyond
the 48px back-swipe zone; dark mode uses a light thumb for contrast. Numeric typing
would restore the interrupted multi-digit edit problem, while the picker requires
an extra opening step. Terminal size is outside this change.

## Verification

The appearance and normalization suites cover saved sizes, both limits, remounting,
and sample rendering. Browser checks exercise touch dragging, keyboard steps and
limits, persisted reload, and narrow layouts. Screenshots use production components
in Storybook; this does not constitute a packaged native-app test.

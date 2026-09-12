# Composer bottom space and edit focus

Status: implemented
Translation: pending

## Abstract

The desktop Session composer had an inert 8px strip below its input card, so
clicking near the bottom failed to start typing. That spacing now belongs to
the card and uses its existing focus handler, while native insets remain on
the shell. Queue editing also missed autofocus when a synchronized edit flag
mounted the field while the start-edit write was still pending; focus now
follows the editable state. The sent-message editor already focused correctly.

## Decision and evidence

The [focus draft](../../../../specs/session-composer-focus.md) records the intended
interaction. The desktop card gains the shell's 8px bottom spacing without
changing the combined height or textarea size. Mobile spacing is unchanged.
Native keyboard lift and remaining safe-area padding stay on the outer shell.
Adding an outer click handler was an alternative, but moving the spacing keeps
the visible card and its click target together and reuses its interactive-control
and disabled-input guards.

For queued messages, mount-only autofocus runs too early if the editing flag
arrives before the start-write acknowledgement: the textarea is still disabled.
An input ref callback focuses the editor after attachment when the write is no
longer pending, placing the caret at the end so typing appends a clarification.
The callback reattaches when pending changes, covering an initially disabled
field without a focus effect. It stays stable on text changes, so subsequent
manual caret positioning is preserved. Focusing directly inside the Edit click
handler would run before the conditional textarea exists or becomes enabled.
Existing save, blur, and IME handling is retained.
Sent-message editing retains its existing callback-ref focus and caret placement.

The queued editor's footer is part of its editing surface. Its whole strip now
prevents the pointer's default mouse-down focus change, rather than protecting
only the confirm button. This keeps blank-space clicks from triggering blur-save.
A click directly on the blank strip then places the caret at the end of the
entire text and scrolls the last line into view, so the strip also serves as an
append-text target. Confirm clicks still commit explicitly and outside clicks
still commit through blur.

## Verification and limits

- Real-component browser tests failed on both running and idle bottom-strip
  clicks before the style change and passed afterward; typing is asserted.
- The real queue-display test publishes the editing flag, holds the start-write
  promise, and then resolves it explicitly. It failed to focus before the fix
  and passed afterward, including editing and saving the new text.
- Browser checks cover both Edit buttons. Existing submission-focus tests cover
  successful and failed sends, navigation, and relinquished focus.
- Mouse and emulated-touch footer clicks reproduced premature editor closure;
  regression coverage also checks continued typing, confirmation and outside clicks.
- These checks exercise repository components with synthetic data. An installed
  production binary and physical native keyboard behavior were not exercised.

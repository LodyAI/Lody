# Composer bottom space and edit focus

Status: implemented
Translation: pending

PR: [#655](https://github.com/LodyAI/Lody/pull/655)

## Abstract

The desktop composer's bottom strip did not focus its input, and queued-message
editing could miss autofocus or close when its footer was clicked. Moving the
spacing into the input card and focusing the queue editor when enabled fixes
these interactions. Footer blank-space clicks now move the caret to the text
end without saving; physical native-keyboard behavior remains unverified.

## Decision and evidence

- Move the desktop shell's 8px bottom spacing into the card to reuse its existing
  focus handler and control guards instead of adding an outer handler. Combined
  height, textarea size, mobile spacing, and shell-owned native insets stay intact.
- The synchronized editing flag can mount a disabled textarea before the start-edit
  write resolves. A pending-dependent callback ref focuses it when enabled and
  places the caret at the text end; mount-only autofocus runs too early. The ref
  stays stable during typing, preserving manual caret placement without a new effect.
- Prevent mouse-down blur across the queue footer and focus at the text end on
  blank-space clicks, scrolling the last line into view. Confirmation and outside
  clicks still save; sent-message editing retains its existing focus behavior.

## Verification and limits

- [Browser regressions](../../../../packages/components/tests/e2e/composer-submission-focus.spec.ts)
  reproduced bottom-strip focus and footer closure failures before the fixes;
  all 15 cases passed afterward, including typing, saving, and emulated touch.
- [Queue lifecycle coverage](../../../../packages/components/tests/message-queue-row-editing.test.tsx)
  explicitly holds and resolves the start-edit promise; focus failed before the
  fix and passed afterward, including editing and saving.
- Validation uses real components with synthetic fixtures; installed production
  binaries and physical native keyboards were not exercised.

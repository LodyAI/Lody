# Prompt suggestion composer hint

Status: implemented
Translation: current

[中文](2026-10-27-prompt-suggestion-composer-ui.zh.md)

Follow-up to [unified ACP prompt suggestions](2026-10-27-prompt-suggestions.md).

## Abstract

The negotiated prompt-suggestion pipeline delivers advisory next-prompt text per
session, but the composer had no surface for it. This change shows the latest
suggestion as an inline hint on an empty draft: a literal Tab key cap followed
by muted text on desktop, and an Apply control on mobile. Accepting only writes
the suggestion into the ordinary controlled draft and focuses the caret; it
never sends or consumes the source, so clearing the draft reveals it again. The
composer stays presentational: the session-scoped subscription hook and
workspace transport are owned outside this change, so end-to-end generation
remains unverified here.

## Interaction contract

- `ChatComposer` takes `promptSuggestion: string | null | undefined`. Only a
  non-empty suggestion on an exactly empty, enabled draft renders. Null, empty
  and whitespace-only values render nothing. Disabled, archived and submitting
  composers hide it.
- Desktop Tab accepts only an unmodified, non-IME Tab whose default is not
  already claimed, and only while the draft is empty. Acceptance writes the full
  text through `onPromptChange`, then focuses the textarea and places the caret
  at the end. It never calls the send path.
- Mobile renders an Apply button and no keyboard acceptance. The overlay ignores
  pointer events except for that control, so pressing the suggestion text or any
  other composer area focuses the input normally.
- The hint derives from the prop on every render; there is no local "consumed"
  state. Typing hides it, clearing restores the same text, and accepting does not
  delete the upstream latest value.
- Each mounted `SessionChatInputArea` passes its own session id to the hook, so
  retained tabs read their own session and the UI shares no suggestion state
  across conversations.

## Verification

- [The new composer suite](../../../../packages/components/tests/chat-composer-prompt-suggestion.test.tsx)
  covers desktop/mobile rendering, empty and whitespace suppression, Tab
  acceptance and caret placement, existing text, Shift+Tab, IME, disabled
  composers, mobile Apply-only acceptance, click-through focus, and restoring
  the hint after clearing. 5 tests pass.
- Existing `chat-composer-focus`, `chat-composer-autoresize`, and
  `session-chat-input-submission` suites pass (65 tests) with the supplied hook
  present.
- Storybook stories `SessionPromptSuggestion` and `SessionPromptSuggestionMobile`
  cover the desktop hint and mobile Apply states, and the static Storybook build
  succeeds. Playwright against the built stories at 900×600 and 420×700 confirmed
  the desktop Tab draft/caret and hidden hint, mobile click-through focus,
  unchanged Tab, Apply-only draft/caret and hidden hint, with no console errors.
- After integration with the owning hook/runtime, `@lody/components` typecheck passes.
- No live model was available, so real ACP suggestion generation and a complete
  app visual check remain unverified.

## Evidence

- [Composer hint](../../../../packages/components/src/components/chat/chat-composer.tsx)
- [Session wiring](../../../../packages/components/src/components/sessions/session-chat-input-area.tsx)
- [Tests](../../../../packages/components/tests/chat-composer-prompt-suggestion.test.tsx)
- [Stories](../../../../packages/components/src/stories/ChatComposer.stories.tsx)

# Conversation full-width mode

Status: implemented
Translation: current

[中文](2026-09-28-conversation-wide-mode.zh.md)

PR: [#1080](https://github.com/LodyAI/Lody/pull/1080)

## Abstract

The session conversation column was hard-capped at ~48rem, which left large
desktop windows mostly empty on either side of the transcript. A per-device
"Full width" toggle now drops that cap so the column spans the pane, keeping
only the shared side gutter. Two entries write the same atom: a Settings >
Appearance switch, and a trailing `Switch` row at the top of the session `⋯`
menu (after the identity block), so a user can flip it without leaving the
page. No SessionMeta change — view preference is not session state and must
not sync across devices or teammates.

## Decision and evidence

- `conversationWideModeAtom` (`atomWithStorage`, `lody-conversation-wide-mode`,
  default `false`) lives in `atoms/settings.ts` beside the other
  conversation-appearance prefs.
- `ConversationColumn` is the ONE place the cap applies: it reads the atom and
  swaps `CONVERSATION_CONTENT_WIDTH_CLASS` for the uncapped
  `CONVERSATION_CONTENT_WIDTH_WIDE_CLASS` in `lib/conversation-layout.ts`, so
  stream rows, context strip, composer, info bar, pin and permission surfaces
  all switch together. `mx-auto` stays — a re-capped descendant still centers.
- Settings gets the labelled switch (`settings.conversationWideMode.*`); the
  `⋯` header menu gets a `Menu.Item` with a trailing `@lody/ui` `Switch`
  (`sessions.fullWidth`), `closeOnClick={false}` so the flip is visible.
  A device-local `localStorage` flag is the right durability class: unlike
  `SessionMeta`, it cannot drag a teammate's or another device's layout with it.
- Behavior test `tests/conversation-wide-mode.test.tsx` pins the atom→class
  contract on `ConversationColumn`; Storybook gained a `wide` arg and the
  `DesktopReadingReviewWide` story so the two layouts can be compared side by
  side in the same story harness.
- Verified: `pnpm typecheck` on `@lody/components`, vitest for
  conversation-wide-mode + appearance-settings (12/12), and Playwright
  screenshots of the capped vs wide column plus the menu Switch.

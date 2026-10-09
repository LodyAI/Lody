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

## Correction: outline clearance (2026-10-02)

PR: [#1205](https://github.com/LodyAI/Lody/pull/1205)

The original 18px desktop gutter let the outline rail overlap wide-mode
messages: the rail occupies 50px including its magnified active tick.
`ConversationColumn` now supplies symmetric 64px gutters from the 640px
breakpoint, keeping messages, composer and other shared column surfaces aligned.
Below that breakpoint the 14px gutter remains; capped mode is unchanged.
This restores usable side clearance without reinstating the content-width cap.

Verification: all 4,641 component tests passed. Playwright measured 64px side
padding at a 1440px viewport, clear of the 50px rail even on hover, and 14px
at 430px. Typechecking, lint, formatting, docs and boundary checks passed.
The root `pnpm check` stopped on the unrelated CLI
`workspace-git-service.test.ts` GitHub-remote backfill assertion, which also
failed when rerun alone.

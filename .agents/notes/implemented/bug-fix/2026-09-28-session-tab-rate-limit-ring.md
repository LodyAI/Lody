# Show subscription usage in new session tabs

Status: implemented
Translation: current

English | [中文](2026-09-28-session-tab-rate-limit-ring.zh.md)

## Abstract

New session tabs hid the usage ring before context usage arrived, even when the
machine supplied subscription limits. The shared session composer now enables
the existing rate-limit-only display, matching the landing composer. Context
usage still takes precedence once available, and missing usage remains hidden.

## Decision and verification

`SessionChatInputArea` passes `showRateLimitWithoutContext` to
`SessionUsagePopover`. This also covers draft tabs and side chats without changing
the popover default or provider eligibility checks. A scoped search found no
existing note owning this display condition.

The existing `session-usage-popover.test.tsx` covers the enabled rate-limit-only
trigger and its details. No duplicate test was added for this prop wiring.
Local test execution, `pnpm check`, and `pnpm format` are blocked by missing
workspace dependencies. Documentation checks have pre-existing broken links into
uninitialized ACP submodules; no application visual verification was performed.

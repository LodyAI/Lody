# Keep the onboarding tour runtime compatible with its composer

Status: implemented
Translation: current

[中文](2026-10-28-onboarding-tour-prompt-subscription.zh.md)

## Abstract

Desktop onboarding crashed when its embedded product composer subscribed to prompt suggestions through an incomplete tour runtime. This prevented new users from reaching Agent configuration and broke all six Desktop smoke journeys. The tour now immediately supplies an empty suggestion through the same subscription contract, without opening a live transport. Production suggestion delivery and smoke assertions remain unchanged.

## Cause and evidence

The [prompt suggestion integration](../feature/2026-10-27-prompt-suggestions.md) added `useSessionPromptSuggestion` to the real session input area. Onboarding mounts that same component through `TourStill` / `TourApp`. Its isolated Jotai store publishes a partial `WorkspaceRuntime` using a type assertion; that fixture had no `subscribePromptSuggestion` method. The hook therefore threw before the Agent configuration heading appeared.

- [Passing run 40618838153](https://github.com/LodyAI/Lody/actions/runs/40618838153), merge `27feabc9cec318c685b9a6f0ad80bc8bf0e5c50e`: all six P0 scenarios / 42 steps passed.
- [First failing run 40620755660](https://github.com/LodyAI/Lody/actions/runs/40620755660), merge `1d7d17b158ff2f636f8140cb1d6f1bb5b1cdad34`: PR #1951 already contained the new composer hook before its merge to main.
- Both the first failure and [run 40622740264](https://github.com/LodyAI/Lody/actions/runs/40622740264) retained a screenshot and trace showing the onboarding route's crash page with `TypeError: e.subscribePromptSuggestion is not a function`. The latter's CLI backlog records successful local workspace provisioning and agent-service readiness.
- Passing and failing jobs used the same runner image `macos-15-arm64`, version `20260907.0337.1`, provisioner `20260828.587`, Node setup `22.23.4`, Electron `44.9.3`, and Playwright `1.58.2`. Their lockfile, journey registry, feature definitions and smoke workflow are identical.
- Run `40620365356` at 02:20 UTC reported workflow success but skipped the Desktop job. It does not establish a passing application launch.

Main's first bad commit is `574cfb00a` (#1951, 02:33 UTC), after `55c6f1f80`. The 02:24 failure was on #1951's own branch; it does not put the regression into main's 02:05–02:24 commit window. Reverting #1991 cannot remove the missing tour subscription.

## Decision

The tour owns its read-only fixture subscriptions just as it owns its repo and cloud fixtures. `subscribePromptSuggestion` reports `null` immediately and returns a cleanup function. The typed subscription contract keeps the fixture's signature aligned with the production runtime. Do not weaken the real hook with an optional-method fallback, which would hide an incomplete runtime. No agent-detection overrides, assertion removal or timeout changes are needed.

The existing TourApp isolation test now runs the real suggestion hook at the composer seam and checks that the mounted tour renders an empty hint alongside its fixture visibility data. This covers the actual fixture store and subscription boundary rather than checking a method's existence.

## Verification

The expanded TourApp test fails on unmodified main with `runtime.subscribePromptSuggestion is not a function`; the repaired TourApp, tour repo and suggestion hook suites pass all five tests.

The same `@LODY-ONBOARDING-001` journey was run against locally built OSS desktops and bundled CLIs in independent checkouts:

| Source | Result |
| --- | --- |
| `55c6f1f80`, immediately before #1951 | 1 scenario / 8 steps passed |
| `574cfb00a`, #1951 unmodified | Same heading timeout and missing-subscription crash page as CI |
| `574cfb00a` plus the five-line fixture fix | Full smoke: 6 scenarios / 42 steps passed |

Both builds use the frozen lockfile and their exact submodule pins. Every launch uses a synthetic disposable profile. Root formatting and documentation checks pass. Workspace typechecks and static checks pass; components pass 6,392 tests and Electron passes 171. Root `pnpm check` stops at one unchanged CLI native Git fixture with `context_unreadable` (4,988 CLI tests pass, four skip). Removing the session-injected Git environment and helper PATH makes that fixture pass all 24 tests; this does not turn the original full check green.

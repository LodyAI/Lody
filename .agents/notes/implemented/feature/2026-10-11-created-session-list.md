# Bound created-session cards in the conversation

Status: implemented
Translation: current

[中文](2026-10-11-created-session-list.zh.md)

## Abstract

Many MCP session creations filled the conversation with navigation cards. Consecutive
pure creation records now share a Subagent Task-style panel with ruled compact rows,
leading status marks, and a header containing the count and expand/collapse control.
Its scrollable viewport shows at most five rows by default; expansion raises the
cap to the task panel’s 22rem rather than removing the scroll boundary. Both batch and separate
creation calls use the same presentation; live titles, statuses and navigation remain
available. Grouping stops at other messages or unhydrated turns, preserving their order.

## Decision and boundaries

The user requested the existing Subagent Task UI. Reuse its panel, separators and
status-mark styles while keeping navigation controls in `@lody/ui`. State belongs
to the creating Operation; clicking a row still opens the child Session. The header
disclosure controls the five-row cap, rather than adopting the task panel's automatic
fold-on-completion behavior. Repeated creation labels and individual card outlines
are removed.

The render layer groups records; stored history and Operation protocols are unchanged.
The first record supplies the stable row key, and the full turn range remains leased
through visible-range reporting. Existing activity folding still uses sibling rows;
only the requested creation-card list has an internal scroller. Five or fewer cards
have no disclosure. The scroll region is keyboard focusable and opts out of drawer drag.

Limiting each Operation alone would leave repeated single-create calls unbounded.
Pure successful legacy completions join groups too; failures, cancellations and
continuation notices keep their summary outside the list. A progress-linked completion
still cannot duplicate cards. This supplements the existing
[creation progress implementation](../../../../packages/components/src/components/ai-gui/README.md#creation-progress)
and preserves the [scroll engine's ownership](../architecture/2026-09-27-conversation-scroll-engine.md).

## Verification

The relation-card suite covers grouping, turn range, threshold, disclosure and navigation,
alongside existing live status and duplicate-completion coverage. Storybook's
`ManyCreatedSessions` uses twenty-two synthetic independent creation records for browser
checks and screenshots. Chromium at 375px and 1280px widths verified a 144px viewport with five
visible cards, internal wheel scrolling, and both disclosure states. Expanded lists
stay capped at 22rem (352px) and scroll to the remaining records.
[Collapsed](../../assets/created-session-list/collapsed.png) / [expanded](../../assets/created-session-list/expanded.png).
Message-selection mode preserves original rows so selected ids still match exported records.
Native iOS WebView behavior requires device verification.

Targeted tests (26), component typecheck, lint, i18n, boundary checks, formatting
and docs check passed. Root `pnpm check` passed typecheck/lint but stopped on two
unmodified CLI tests: macOS `/var` versus `/private/var` in worktree inspection,
and the native Git fixture's `context_unreadable`; both reproduced separately.

## Ablation evidence

Against `4c8bf23db`, each candidate was removed independently before combining the
accepted changes. Removing the empty wrapper, deriving the ending turn from existing
group members, and validating legacy results in one pass preserved relation rendering,
navigation and browser behavior. The early empty-message check is covered by the final
empty-card check. The browser observed the actual visible-turn callback (`0:22`), rather
than asserting an internal cached index.

| Removal | Observed result | Decision |
| --- | --- | --- |
| Wrapper and unused creation markers | Relation tests and browser checks pass | Remove |
| Cached ending-turn field | Full `0:22` hydration range retained | Derive from group |
| Repeated legacy-result validation | Success cards and failure summaries retained | Single pass |
| Empty legacy-result guard | Completion summary disappears beside successful creations | Keep guard |
| Five-row height cap | Default viewport grows to 352px / twelve visible rows | Keep cap |

The combined version passes 26 relation/virtual-row tests. The existing scroll-engine
browser suite now covers five visible rows, actual grouped hydration range, wheel
scrolling in both states, and restored height after collapsing at 375px and 1280px.
Fixtures are synthetic; no captured conversation data is included.

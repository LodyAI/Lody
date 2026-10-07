# Session run-config drafts survive tab navigation

Status: implemented
Translation: current

[中文](2026-10-07-session-run-config-drafts.zh.md)

## Abstract

An unsent Fast change in an existing Codex session disappeared after switching
away and back because the composer owned the change in component-local state.
Existing-session run-config edits now live in session-keyed app state, preserving
both explicit on and off choices without changing another tab. Selection stays a
pure derivation, and only a newly accepted logical Turn may acknowledge captured
edits. This is an in-memory draft, not persistence across application restarts or
a new synchronized configuration authority.

## Decision and evidence

The selection hook's old `useState` fence was lost on composer unmount and cleared
on target change. `preserveUnsentUserEdits` only protected changes within one
mount. The [run-config documentation](../../../docs/sessions-run-config.md) already
uses session-keyed app state for Role choices; the underlying knob edits need the
same lifetime. A keyed Jotai atom now owns only edits and their source fence, while
landing and new-session callers keep a private instance atom.

The effective configuration remains user edit > runtime baseline > Turn
preference > capability default. No resolved selection is written back. A guarded
effect commits only consumed edits and known source identities; event writes
first advance the same fence so a late effect cannot erase a newer choice. A
new logical Turn drops only fields it captured; divergent next-draft edits remain.
Observed source lineage prevents queue removal, reordering and older history
backfill from being mistaken for acceptance. Disabled hydration neither records
sources nor consumes edits. Callbacks retain their original session atom.

This preserves the logical-Turn identity rule in the
[held-send decision](2026-09-30-composer-pending-send-config.md): held-send promotion
must not consume a same-valued next-draft edit. Caching the whole resolved
configuration would create a competing runtime authority and risk the previous
selection feedback loop. Writing unsent choices to the shared Session document
would publish a private draft prematurely.

## Verification and limits

The existing selection regression suite covers same-instance and remounted A/B/A
navigation, explicit Fast off, two-tab isolation, disabled hydration, captured
versus divergent edits, known-source rollback/backfill, held-send promotion, and
callbacks from a previous tab. Fixtures are synthetic and tests use synchronous
React commits rather than sleeps. On base `1117f153`, the complete components
suite passed all 4,824 tests across 554 files, alongside workspace type checking,
type-aware lint, i18n, boundary checks, formatting and documentation checks.
The full CI command stopped in unmodified CLI suites on the sandbox's unavailable
default home data directory, rejected Unix sockets, injected proxy environment and
WebRTC limitations; representative failures reproduced on untouched `1117f153`.
After integrating upstream Agent Role memory changes through `a6c3cbc7`, all 50
focused tests, components type checking, changed-file type-aware lint and document
checks pass. The complete suite was not repeated on that later base. Packaged
Electron acceptance is not claimed.

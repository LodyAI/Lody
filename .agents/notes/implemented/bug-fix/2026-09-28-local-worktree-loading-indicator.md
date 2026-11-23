# Show local worktree loading state

Status: implemented
Translation: current

[中文](2026-09-28-local-worktree-loading-indicator.zh.md)

## Abstract

The local-project worktree control was disabled while Git state loaded, but gave no
visual indication that the request was still in progress. The shared worktree pill
now replaces its checkbox with a same-size spinner and exposes a busy state while
the local Git probe runs. The mobile workdir tab uses the same cue, while the
existing disabled behavior remains in place until branches are available.

## Decision

The loading cue belongs in `WorktreeCheckboxPill`, which is the shared control used
by the chat landing and other worktree surfaces. A `loading` prop keeps the control
inert, sets `aria-busy`, and replaces the checkbox with the UI spinner so the pill's
geometry does not jump. Chat Landing passes the local Git-state request state and
uses the same loading wording for the tooltip; GitHub's required-worktree pill is
unchanged. The mobile local workdir tab replaces its branch glyph with the spinner
and exposes the same busy state.

## Verification

The focused component test covers the loading spinner/busy state and the normal
checkbox state after loading, but could not run because Vitest is not installed in
this nested checkout. Formatting and diff whitespace checks passed; full repository
checks were not run.

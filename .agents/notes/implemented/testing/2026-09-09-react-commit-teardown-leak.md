# A React commit outside act can fail the run from the next test file

Status: implemented
Translation: current

[中文](2026-09-09-react-commit-teardown-leak.zh.md)

## Abstract

`tests/mobile-chat-list-preview-cap.test.tsx` committed its renders and its
unmount through `flushSync` rather than `act`, which leaves React's
passive-effect flush queued on the real macrotask queue. That callback reads
`window.event` before it does anything else, so when Vitest tore the file's jsdom
environment down first, it threw as an unhandled error and failed a run in which
all 3313 tests passed. Every commit in the file now goes through `act`, and its
teardown awaits one `setImmediate` so nothing React queued outlives the DOM it
expects. The same `flushSync` pattern appears in dozens of other suites, so this
fixes the file that lost the race rather than the class; a suite-wide sweep is
still open.

## Decision

Route every commit through `act` and set `IS_REACT_ACT_ENVIRONMENT`, as 148
other suites in this package already do. `act` drains passive effects inside the
test, so no scheduler callback is created for them in the first place.

That alone was not enough: one commit per test still escaped, leaving a single
queued callback. Rather than keep hunting a stray update inside a component tree
this file only observes, teardown awaits one `setImmediate` after the unmount.
The macrotask queue is FIFO, so every callback queued before it has run by the
time it resolves — an ordering barrier, not a sleep, and not a wall-clock race.
Both parts are needed: `act` removes the bulk deterministically, and the barrier
closes whatever remains.

## Evidence and limits

The failure mode was reproduced deliberately: a copy of the file with an
`afterAll` that deletes `globalThis.window` and then lets the macrotask queue run
— standing in for Vitest's teardown winning the race — reported three
`ReferenceError: window is not defined` unhandled errors, the same error and the
same file as
[CI run 34323149523](https://github.com/LodyAI/Lody/actions/runs/34323149523).
Moving the commits into `act` took that to one; adding the teardown barrier took
it to zero, with all nine tests still passing. The same probe against
`tests/markdown-mermaid-fullscreen.test.tsx`, which already awaits `act`,
reported nothing, and a minimal render-and-unmount-inside-`act` fixture also
reported nothing — so the leak is a property of commits made outside `act`, not
of React's unmount.

Limits: the CI failure itself never reproduced locally, on eight workers or on
two, pinned to a single core or not; the probe is a deliberate simulation of the
race, not the race. The stray per-test commit that survives `act` was not traced
to its source — the scheduler captures `setImmediate` before a test file can
instrument it — so the barrier is what covers it. Dozens of other suites commit
through `flushSync` and remain latent; they are green today only because their
queued callbacks normally run before teardown.

Related: [Mermaid diagram gestures](../bug-fix/2026-09-09-mermaid-diagram-gestures.md),
whose pull request surfaced this by shifting test timing.

# Warm-window adoption and content readiness

Status: implemented
Translation: current
PR: [#885](https://github.com/LodyAI/Lody/pull/885)

[中文](2026-09-22-warm-window-content-readiness.zh.md)

## Abstract

Claimed warm windows could expose Loading or transient Session Not Found, remain
classified as disposable spares, and recover to the neutral warm route after a
crash. Adoption now clears the spare identity and persists the real reload target
before navigation. Reveal requires the matching target surface, and absence waits
only for that Session's metadata projection. The five-second recovery fallback
remains; this does not prefetch target data or eliminate opening latency.

## Decision and evidence

This corrects adoption and reveal following the
[window prewarming decision](../feature/2026-09-18-desktop-window-prewarming.md).
The [desktop window Spec](../../../../specs/desktop-windows.md) describes the result.
The renderer's former `innerText` check accepted Loading, sidebar text, and missing
Session messages. It now waits for two frames containing the matching Session or
workspace marker. A visible conversation emits its marker after its document is
ready and synced; confirmed absence is also a valid terminal surface. Workspace
landing emits its marker when mounted. Recovery still becomes accessible after
five seconds, including when navigation fails.

`window-target.ts` adopts a spare before sending its navigation event: it clears
main's warm marker and updates the recovery destination using the same path builder
as cold windows. `window-state.ts` owns registration and close cleanup, so an adopted
window can become the main fallback and survives closing the previous main window.
Only the current spare's close callback clears its readiness timer; a previously
claimed window cannot cancel its replacement's timeout.

`doc-meta.ts` keeps bootstrap readiness separate from per-Session projection
settlement. Queued events, the latest full metadata read, and unresolved/failed
reads block absence only for their own Session. Later events can retry reads;
deletion clears unresolved work and stops waiting for obsolete reads. Runtime
disposal clears pending markers and fences late completions. A workspace-global
settlement gate was rejected because an unrelated failed or empty metadata read
could leave a missing Session loading forever. Existing Sessions do not subscribe
to pending-state churn; workspace chrome still uses bootstrap readiness.

A fixed delay or checking translated Loading strings would only hide the race for
some timings/languages. Explicit readiness preserves the existing neutral shell
without coupling to text or changing cold-window behavior. It still costs a warm
renderer and loads target data after claim.

## Verification and limits

Deterministic tests exercise closing the original/adopted windows, recovery targets,
replacement timeouts, queued/delayed metadata, target deletion during a read,
unrelated failed/missing metadata, runtime replacement, target-specific reveal,
consecutive frames, and the recovery deadline. All 34 tests in six focused suites
passed, as did components and Electron main/renderer typechecks. Changed-source
lint has no errors (two pre-existing warnings in the conversation component).
Real Electron visual acceptance remains unverified. E2E still disables the warm
pool. This worktree reuses locally available dependencies; `pnpm check` stops at
missing dependencies in `packages/ignore`. `docs check` reports 34 existing links
into absent ACP submodules, none in the changed documents.

# Keep multi-file diff opening responsive

Status: implemented
Translation: current
PR: [#1648](https://github.com/LodyAI/Lody/pull/1648)

[中文](2026-10-17-multi-file-diff-opening.zh.md)

## Abstract

Opening a complete turn's diff could synchronously compute medium-sized rewrites and mount every file's changed rows. Multi-file panels now parse cache misses in the existing Worker and load/mount bodies near the viewport, retaining filename shells, expansion state and explicit focus. The viewport preserves the user's visible file as earlier bodies expand, and interacted bodies remain mounted so selections, context expansion and comment drafts survive scrolling. All Changes retains its bounded inline batch and loads deferred content on visibility. This first implementation bounds opening work across many files; it does not provide per-line virtualization for a single huge diff or progressive inline batch decoding.

## Evidence and prior behavior

The [focused-file expansion decision](2026-09-27-all-changes-single-file-expansion.md) remains unchanged. Unfocused turns are logically expanded, unfocused All Changes is collapsed, and a focused action opens only its target.

With the installed patched `@pierre/diffs` 1.0.10, a five-sample Chromium 145 parser probe measured a 279.2ms median for a complete 2,000-line rewrite, despite only 83,563 combined characters. The former 200,000-character threshold ran that computation during React render. A separate single-run native renderer probe, with metadata already parsed and a shared render Worker initialized, mounted 30 files with 400 changed rows each: 61,260 shadow DOM nodes, 216ms synchronous hydration and 503.8ms forced layout. These are synthetic scaling observations, not actual desktop input-latency measurements.

## Implementation and trade-offs

- `SessionConversationDiffPanel` retains all lightweight file shells and uses `useDiffViewport` to select nearby work. One intersection observer tracks the scrollport plus 600px overscan, bootstrapping two files before the first observation and always including explicit focus. Turn reads and All Changes deferred reads share the bounded per-file loader; the latter retains the existing batched inline request.
- A shared resize observer preserves a visible file's offset when preceding files grow. At the bottom it anchors the last visible file, so an overscan file expanding cannot push the requested last file far below the viewport. Native anchoring is disabled only in this managed content region to avoid double correction and focused-header anchoring.
- `DiffViewer` suspends only the code body. It retains collapse/comment state and records body height before suspension. Bodies with pointer or keyboard interaction stay mounted to preserve native selection, expanded unchanged context, reply text and drafts. This deliberately trades memory for interaction state in files the user has touched; it does not cap their cumulative DOM.
- Multi-file cache misses use the existing shared parse Worker at every size. Parse starts are serialized before their worker timeout begins, and obsolete queued bodies are skipped. A viewer retains its exact-input parse promise across suspension, avoiding duplicate jobs on return. Request identity includes complete input references/strings rather than sampled text, preventing equal-length edits outside the sample from temporarily reusing stale results. Immutable turn checkpoint caches retain their established keys and survive provider-only rebuilds; no path/length-only live cache was added.
- Changing visibility cancels queued starts, but already-started reads retain their slots until settlement and may publish valid results for the same source. A source/batch identity fences obsolete data and late results, with settlement waking the next loader pass. Hidden desktop panels do not start new diff or GitHub-comment reads.
- Storybook excludes the locked Pierre package's entry points from dependency prebundling and explicitly optimizes its CommonJS `lru_map` child. Version 1.0.10 marks a source-only web-component path as side-effectful while shipping `dist`; prebundling otherwise removes `<diffs-container>` registration, leaving existing stories with blank bodies. This is a preview configuration correction, not a dependency upgrade or a replacement renderer.

Adding workers alone cannot bound DOM/layout. Collapsing all turn files would alter established behavior. A full Pierre upgrade for per-line virtualization is deferred because the locked release lacks those APIs and carries a newline-splitting compatibility patch. Pure React rendering and request hooks remain ordinary TypeScript; this change introduces no Effect lifecycle boundary.

## Ownership and verification

The [file-surface guide](../../../docs/sessions-file-surfaces.md) owns current behavior, and [session scope rules](../../../../packages/components/src/components/sessions/AGENTS.md) bind callers. The dedicated `ConversationDiffPanel` stories use synthetic 200-file providers and real panel/viewer components. `OpenFromChanges` starts with no mounted diff and uses a synthetic Changes button to open the real desktop sidebar layout and panel, with close/reopen controls. It covers the layout transition and first panel mount, rather than the full `SessionDetail` controller or Electron data path. Reloading the preview resets its in-memory diff caches for a cold first click. Unit regressions exercise visibility, hidden/resumed panels, pending-read settlement, live batch invalidation, exact input identity, worker failure and retained unsent input. Browser regressions cover clicking to open, close/reopen, bounded code DOM, collapse/return, last-file focus, deferred All Changes expansion, and existing large-file scrolling.

Validation passed: 41 targeted unit tests, all five browser regressions, components typechecking, changed TypeScript lint, i18n validation, changed-file formatting, and `git diff --check`. A 1200×800 Chromium probe of the real 200-file panel measured one mounted code body with 4,443 shadow nodes initially, and two bodies with 10,486 nodes after scrolling to the last file; all 200 filename shells remained available. Those snapshots are not a production latency benchmark. The browser screenshot was inspected for real diff text, line numbers and split layout.

`pnpm format` passed. `pnpm check` stopped during CLI typechecking because the worktree lacks the Claude, Codex, Grok and Devin ACP submodules and Claude SDK declarations; the root command did not reach its test phase. `pnpm run docs check` reports 31 links into uninitialized submodules; none concern the added note or changed guide, and no protected topics are registered. The full repository suite and Electron session profiling were not run. Large single-file virtualization and inline-batch decoding remain outside this implementation. No human Spec approval is claimed.

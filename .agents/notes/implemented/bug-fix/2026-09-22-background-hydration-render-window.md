# Keep background hydration out of rendered conversation membership

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/888

[中文](2026-09-22-background-hydration-render-window.zh.md)

## Abstract

Background fact scans hydrated older turns in the same cache used by the conversation
stream. Rendering every cached body let an offscreen placeholder become several rows,
move the visible tail's numeric indices and temporarily hide its unmeasured Virtua rows.
The stream now renders bodies only for its reading window, retained tail and native text
selection; other hydrated bodies remain placeholders. A controlled synthetic browser
reproduction changed from five post-reveal hidden-row samples to zero while all facts
completed. Attribution and acceptance in the installed desktop remain unverified.

## Decision

The [windowed-reader integration](../architecture/2026-09-10-windowed-reader-integration.md)
keeps one shared body cache and separate consumers. Cache residency is not render
ownership: `useConversationStreamItems` supplies the body eligibility predicate to
`buildChatStreamItems`. Fact derivation, search indexing, copy and outline preview reads
retain their existing data access. A loaded user predecessor still supplies assistant
configuration even if its own body is outside the render window.

The initial 40-turn tail remains leased when a viewport report narrows the reading
window. Otherwise background eviction could collapse formerly rendered tail rows after
reveal. An off-tail reader therefore retains that bounded tail in addition to its reading
window, rather than relying solely on the view's default 20-turn retention. Native
selection publishes its retained turn IDs to the stream before scroll-driven window
changes; its existing leases and layout snapshots preserve selected DOM. Release removes
the render exception. Projection wrappers use the same underlying-source fence.

Changing the initial visibility gate or waiting for a full fact scan would delay display
without separating these responsibilities. Changing Virtua's `shift` setting cannot map
arbitrary placeholder expansion to stable message keys. Neither is part of this fix.

## Evidence and verification

The isolated browser harness used the production reader-backed view, derivation, stream
hook and sticky-scroll hook with Virtua 0.49.1. Its 240-turn fixture used a synthetic
reader port and simplified variable-height rows, not the full session renderer. Explicit
signals released background batches after reveal; no artificial ResizeObserver delay or
CPU throttling was applied. Before the fix, five batches hid all seven intersecting rows
for one sampled frame each (about 16 ms); the video also captured a blank content area.
After the fix, all 240 facts completed with zero post-reveal hidden-row samples. The fast
default-scheduling fixture completed scanning before reveal and did not reproduce that
post-reveal flash. This establishes a sufficient mechanism, not its production frequency.

The capture's pane visibility does not establish row visibility: hidden Virtua rows still
have measurable rectangles. Its anchor classifier also ignores changes accompanied by
scroll movement. Geometry alone must not be reported as proven painted overlap.

The owning hook regression fails on the original implementation when background batches
promote placeholders. The fixed focused suites cover loading and eviction, the first
viewport report, reading-window movement, source/projection replacement, selected DOM
preservation and release, inherited configuration, and existing scroll behavior: 65 tests
passed. `ConversationViewStream.OpenWithBackgroundFacts` exposes explicit batch controls
for the full stream renderer; it still needs browser execution in a complete dependency
environment. Scoped lint has no errors. Full component typechecking is blocked by missing
workspace/dependency declarations and other baseline errors in this checkout. Repository
document checks retain pre-existing missing-submodule links. No desktop acceptance is
claimed, and no captured user conversation is included.

# Keep share requests outside virtual conversation rows

Status: implemented
Translation: current

[中文](2026-09-16-share-request-virtualization.zh.md)

PR: [#755](https://github.com/LodyAI/Lody/pull/755)

## Abstract

Pending share requests lived in the conversation's first virtual row, together
with their query subscription and editor state. Restoring a long conversation to
its bottom could evict that row before the query returned, leaving no card at all.
The session surface now mounts the cards below the message viewport, outside
Virtua, in a height-bounded scroll area. A deterministic simulation reproduces the
old subscription loss and verifies delayed delivery and editor retention with the
new placement; it does not establish the cause of every production report.

## Decision

`session-chat-interface.tsx` owns the placement. Only conversation provenance stays
in `leadingContent`. Sharing keeps its existing workspace, identity and visibility
gates, canonical query, human confirmation and local error boundary. No backend or
publication contract changes are needed under the [sharing Spec](../../../../specs/session-sharing.md).

The request area uses at most 35vh and scrolls separately so multiple pending
requests cannot consume the whole message viewport. Unlike retaining a hidden
first virtual row, this also puts the review action near the composer. The editor
continues to be owned by the cards and no longer disappears on message scrolling.

This complements [query-error isolation](2026-09-14-share-request-cards-query-isolation.md):
that fix handles a throwing query, while this fix keeps its subscriber mounted.

## Verification and limits

`session-share-request-cards.test.tsx` uses real React, Virtua and the request-card
component, with a synthetic external query store and explicit resize/scroll
signals in jsdom. Sixty synthetic rows, a 400px viewport and an 800px buffer place
the first row outside the rendered range after bottom restoration. The query is
held unresolved until after that transition. In the old leading-row placement its
subscriber is gone and no card appears; in the sibling placement the pending card
appears, opens review, and retains the editor through confirmation and scrolling
back to the beginning. There are no real sleeps or network requests.

The sharing suite (five tests), existing Virtua scroll suite (two tests) and
components typecheck passed. The simulation models the two placements rather than
mounting the entire session page; the live hosted query and packaged-client visual
acceptance remain outside this verification. The docs check still encounters
uninitialized unrelated ACP submodule links in this checkout.

## Ablation

The test file was reduced from 273 to 252 lines without removing behavioral cases.
Removing the custom `scrollTop`, `scrollHeight` and `clientHeight` properties left
all five sharing tests passing: ResizeObserver supplies the viewport size and
jsdom's own scrollTop suffices. Removing the `offsetParent` shim broke both
virtualization cases, so it stays as a getter spy. Global cleanup now runs once
in afterEach after root unmount; the extra unmount/new-root cycle, descriptor
restoration and unused sibling wrapper were removed, with all seven tests passing.

Replacing the query subscription with a plain snapshot failed the delayed-card
visibility assertion in the fixed placement (four pass, one fail). The subscription
was restored. Initial rendering now asserts visible message content instead of a
subscriber count. These tests do not measure CSS layout, so this experiment does
not justify removing the production height bound or conversation column.

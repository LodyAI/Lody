# Publish actual session models in catalog metadata

Status: implemented
Translation: pending

## Abstract

Session catalogs carry a working branch but no actual model, so list consumers
would otherwise need to load each transcript. The CLI now projects the latest
assistant model into an optional metadata field through its existing session
document. The projection follows history changes, including model updates and
rewinds, while coalescing publication and excluding opaque provider metadata.
Historical sessions remain unknown until their documents are normally observed.

## Decision

`SessionDocument` owns one disposable subscriber over `sessionData.history`.
`SessionMeta.lastModel` contains only a model id and display name. Requested
configuration is intentionally excluded: it can differ from the model used.
The latest assistant with missing model data produces an unknown model, rather
than borrowing an older turn's name. Assistant entries with no items and no plan
are skipped: the executor opens an entry with `modelInfo` before any output
exists, and interrupted or failed turns leave that empty entry in history while
the renderer hides it, so advancing on it would name a model that never answered. Absence, no assistant (`null`), and an
assistant with unknown model (`{}`) remain distinct.

Publication coalesces concurrent changes, serializes writes, and skips identical
summaries. Errors leave the summary eligible for the next change or teardown
flush. The publisher checks existing visible metadata and never creates a hidden
fork target or revives a deleted session. The fork commit writes history before
the target's metadata row, so that first projection is skipped; the commit
re-syncs the summary after the row lands instead of waiting for a later change. Normal document lifecycle supplies the
only subscriptions; no workspace-wide backfill is introduced.

The alternative of reading every session in a list would add room subscriptions
and transcript transfer. Per-provider callbacks would miss import and history
rewind paths. The existing shared [HistoryWriter](../architecture/2026-09-07-single-history-writer.md)
remains the sole history writer; this subscriber only projects metadata.

## Verification and limits

Real Loro history writes exercise model changes, late edits to older entries,
rewinds, streaming deduplication, concurrent publication, failure retry and
disposal. SessionDocument coverage checks resulting metadata and hidden/deleted
targets. No real model requests or hosted service changes are needed for these
checks. Existing producers must upgrade; unopened historical rooms are not migrated.

Contract: [draft Spec](../../../../specs/session-model-summary.md).

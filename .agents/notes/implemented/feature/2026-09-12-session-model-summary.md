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

`SessionDocument` owns one disposable subscriber over its existing Mirror.
`SessionMeta.lastModel` contains only a model id and display name. Requested
configuration is intentionally excluded: it can differ from the model used.
The latest assistant with missing model data produces an unknown model, rather
than borrowing an older turn's name. Absence, no assistant (`null`), and an
assistant with unknown model (`{}`) remain distinct.

Publication coalesces concurrent changes, serializes writes, and skips identical
summaries. Errors leave the summary eligible for the next change or teardown
flush. The publisher checks existing visible metadata and never creates a hidden
fork target or revives a deleted session. Normal document lifecycle supplies the
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

# Actual model in session summaries

Status: draft
Translation: pending

## Scenario

A session list should identify the model that produced the latest assistant turn
without subscribing to every conversation. Selecting a different model for the
next prompt must not relabel the previous response.

## Contract

The owning CLI projects the latest assistant history entry's `modelInfo` into
optional `SessionMeta.lastModel`, retaining only `modelId` and `name`. The field
does not include provider extension metadata, launch settings or requested input
configuration. Later changes to an older assistant entry cannot replace the
latest entry's model. Rewinding history recomputes the summary from retained history.

An absent summary means this producer has not supplied it. `null` means the
observed history has no assistant entry. An empty object means an assistant
exists but its model is unknown. Consumers must not interpret absence as proof
that the session has never run.

Projection follows documents already open for normal work; it must not enumerate
and open historical rooms. Streaming unchanged model data does not rewrite the
catalog. Publication is serialized and does not block the prompt path; a failure
is retried on the next document change or flush. Existing persistence and Streams
transport own delivery. Hidden fork targets and deleted sessions are not published.

## Limits and evidence

Older producers and unopened historical sessions may have no summary. This is
an additive display field, not a dispatch input or a bulk migration. Simultaneous
owners and arbitrary mixed-version rollback are not new guarantees.

- `apps/cli/src/lib/loro/session-model-summary.ts` and its behavioral tests.
- `apps/cli/src/lib/loro/doc.ts` owns subscription and teardown.
- [Decision](../.agents/notes/implemented/feature/2026-09-12-session-model-summary.md).

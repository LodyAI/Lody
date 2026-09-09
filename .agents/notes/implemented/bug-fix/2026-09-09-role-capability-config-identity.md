# Match Role capabilities to the current provider configuration

Status: implemented
Translation: pending

## Abstract

A readable capability row can belong to a provider configuration that has since changed. Role
availability previously accepted such rows after a custom launch command changed or a builtin
runtime override was removed, allowing obsolete lists to enable or reject saved Roles. The Role
reader now checks the configured provider identity before using the row, while preserving readable
older cache formats. The owning daemon now separately publishes its expected source versions, so runtime package
changes are checked without comparing remote machines to renderer-bundled versions.

## Decision

The shared `getReadableAcpCapabilityCacheEntryForConfig` composes the existing compatibility reader
with exact CLI/provider identity, custom launch serialization, and bidirectional builtin override
matching. The current configuration is authoritative for these fields, so a mismatch supplies no
capability evidence to the Role resolver and leaves pinned selections unknown. Other readers keep
their existing cache-readability behavior. Cache version differences alone still do not invalidate
understood capability fields.

## Evidence and limits

Three deterministic hook regressions failed before this change and pass afterward: an obsolete
custom command could wrongly enable a previously supported model, wrongly reject a newly supported
model, or leave an override-backed Role selectable after its override was removed. The same tests
publish a matching custom snapshot and verify that Role availability and mentions recover. Existing
coverage retains readable older cache formats and the negotiated Cursor picker boundary.

[The review finding](https://github.com/LodyAI/Lody/pull/345#discussion_r3965815859) also covers
ordinary runtime revisions. The `acpCapabilitySources` v1 protocol adds a Machine Flock snapshot
of expected versions and a small daemon epoch in Machine metadata. Discovery reads the owner's
installed current/fallback runtime selection, without installing or probing. Registration,
config changes, authoritative rejoin, and committed runtime installs trigger invalidation and
coalesced discovery. Observed capability writes never update expected sources. Serialized writes,
generation checks after asynchronous document opens, and a shutdown fence reject late work.

Missing or mismatching evidence keeps capability-dependent Role availability unknown. Daemons
without this protocol preserve existing readable-cache behavior, as explicitly selected for
backward compatibility; ordinary runtime freshness on those older daemons remains unverified.

Deterministic tests cover old evidence falsely enabling and rejecting models, a matching older
cache format recovering, missing/previous epochs, late old observations, failed source discovery,
rescan recovery, and stopped writes. The new snapshot travels through the existing Machine Flock
subscription and metadata overlay; no per-Role subscriptions or landing probes were added.
No live desktop or Windows verification has been performed for this change.

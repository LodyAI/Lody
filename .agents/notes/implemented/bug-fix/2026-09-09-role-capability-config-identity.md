# Match Role capabilities to the current provider configuration

Status: implemented
Translation: pending

## Abstract

A readable capability row can belong to a provider configuration that has since changed. Role
availability previously accepted such rows after a custom launch command changed or a builtin
runtime override was removed, allowing obsolete lists to enable or reject saved Roles. The Role
reader now checks the configured provider identity before using the row, while preserving readable
older cache formats. This addresses observable configuration changes; it does not establish the
current package version of a remote runtime.

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

[The review finding](https://github.com/LodyAI/Lody/pull/345#discussion_r3965815859) also describes
ordinary provider/runtime package revision changes. The current Machine read model does not expose
the owning daemon's expected capability source version. Comparing against the renderer's bundled
versions would misclassify mixed-version machines. That remaining case needs an owner-published
source identity and an explicit compatibility policy for older machines; this configuration check
must not be presented as full runtime-version validation. No live desktop or Windows verification
has been performed for this change.

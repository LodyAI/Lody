# Managed Pi ACP and confirmed provider migration

Status: implemented
Translation: current

[中文](2026-09-17-builtin-pi.zh.md)

## Abstract

Pi previously appeared only as a registry adapter. The builtin now consumes an
isolated, pinned adapter submodule through a managed runtime archive, including
the official Pi CLI and Windows binaries from the same revision's successful CI.
The landing card upgrades existing provider rows only after owner confirmation
and daemon capability negotiation. Legacy native session IDs cannot be converted;
the card explains the need for a new chat and the old launch entry remains available.

## Decision

Use the existing managed download/cache/update path and a Node package archive,
instead of bundling Pi dependencies into the desktop. Package all supported optional
platform dependencies with a frozen isolated install. Strip installation metadata
containing builder paths/timestamps, verify repeatable archive bytes, and run the
adapter's synthetic model smoke against the packaged closure.

Migration changes only provider identity fields inside `flockRowUpdate`, preserving
concurrent edits visible to that transaction. It neither stores workspace-meta flags
nor rewrites history. Runtime authentication remains host-owned; Pi has no built-in
interactive login method. See [the draft Spec](../../../../specs/builtin-pi.md).
The daemon computes `builtinPi` from the actual Node version and platform, not the
shared static capability map, so supported older CLI hosts cannot migrate into an
unlaunchable runtime.
Builtin auto-registration checks for legacy Pi on the synced target machine before
checking for builtin Pi. This avoids creating a second durable provider before
confirmation; unrelated machines and other builtin providers remain unaffected.

## Verification limits

Focused launch, migration, authentication and protocol tests cover local behavior.
Packaging smoke uses the official CLI with a local synthetic model. It does not prove
commercial-provider quality or Windows runtime behavior on this macOS host.

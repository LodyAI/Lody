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

## Extension follow-up (2026-09-20)

[#780](https://github.com/LodyAI/Lody/issues/780#issuecomment-5712334027) approves
explicit extensions and global discovery. The follow-up keeps the original migration
unchanged and reuses Pi's read-only package resolver instead of copying its package
layout. Discovery never grants consent; selected paths live only in Provider runtime
overrides and propagate to native children. Capability refresh and launch normalization
must preserve arrays, and clearing the list must invalidate the old plugin model catalog.

Source implementation and synthetic checks do not publish a runtime. Release remains
blocked on a checksummed artifact containing matching Windows CI binaries; the old
manifest intentionally advertises no extension support. See the updated draft Spec
for the contract. No new executor, profile copy or plugin sandbox is introduced.

## History import follow-up (2026-09-25)

History sync failed with "does not advertise sessionCapabilities.list": the adapter
implemented only resume. [LodyAI/acp-extension-pi#4](https://github.com/LodyAI/acp-extension-pi/pull/4)
adds `session/list` through Pi's own read-only `SessionManager` and `session/load` as
resume plus a replay of the current branch from `get_entries`. Standard ACP load was
chosen over Codex's `_lody/session/history/read` because the importer already
consumes it without provider branches. Advertising load would make ordinary chat
resume replay the whole session, so the host prefers resume for builtin Pi as it
already does for Kimi. Replay drops the resume-time checklist and emits todo
snapshots in place; appending the current checklist would move it between turns
and break prefix matching on later syncs. Release still needs a new runtime artifact.

Adversarial review added two adapter rules: a missing session file fails
resume/load, because Pi silently opens it as a new empty session; user images are
replayed so the importer counts them as dropped, which blocks a lossy conflict
replacement. Listing may leave an empty per-cwd directory in Pi's store: avoiding it
meant copying Pi's private directory encoding, whose drift would silently list nothing. Re-syncing a
continued or mid-turn session can still conflict: Lody-only items (attachments,
task cards, retry/compaction activity) are absent from Pi's file. That is the shared
importer's prefix model, not a Pi adapter gap, and is left for a separate change.

[#972](https://github.com/LodyAI/Lody/issues/972) (imported Pi sessions show no model
choices and lose their model) has one cause across providers: import creates a
continuable session but skipped two facts a Lody-started session records while
running, its Provider (`agentConfigId`) and native selection (`acpRuntimeConfig`),
although listing and `session/load` already had both. New imports list, load and bind
through the machine's only same-type Provider. With none or several they stay unbound,
because guessing could move a native session to another account or endpoint. A
session must be loaded with the launch it continues with, or a Provider-set data
directory such as `CODEX_HOME` points refresh and continuation at different stores.
So refresh loads through the session's own binding, not the current sole Provider,
and an earlier unbound import is bound only when that Provider lists it; adversarial
review found both gaps in the first version. Every import write,
refresh included, records the load-reported selection for the last imported user turn
through `applyAcpRuntimeConfigPatch`, whose fence keeps a newer Lody turn's selection;
refresh must write because appended turns invalidate the old one. Unchanged: Codex's
read-only history reports no selection, and a composer without a selection still sends
its guessed defaults.

## Verification limits

The landing filters legacy providers by their own machine's `builtinPi` capability.
The card count, visibility and confirmed write loop use that supported subset, so
one outdated machine does not block others. Unsupported providers remain unchanged
and become eligible for a later confirmation when their machine updates. With no
supported providers, both the card and its otherwise empty notice wrapper are hidden.
Migration progress and retry feedback remain available for supported providers.

Focused launch, migration, authentication and protocol tests cover local behavior.
Packaging smoke uses the official CLI with a local synthetic model. It does not prove
commercial-provider quality or Windows runtime behavior on this macOS host.

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

Correction (2026-09-30): the published `0.2.0-lody.5cbd610f8476` artifact ships both Windows modules and
declares `lody.piExtensionsProtocolVersion: 1`, but its committed manifest dropped
the field, so the daemon never advertised `piExtensions` and the settings section
stayed disabled. The manifest now carries the field; the fixed-host capability test
requires `piExtensions` wherever `builtinPi` is advertised, so a runtime bump that
drops it again fails on every test host.

### Model-picker repair (2026-10-07)

Extension-enabled probes stamped `+override:{"piExtensions":[...]}` correctly,
but `useSessionAcpSelectorContext` omitted the Provider's `runtimeOverrides`.
The shared applicability gate treated that omission as removed extensions and
rejected the entire Pi catalog. Pi has no static fallback. Landing and Provider
rows already supplied overrides, explaining the inconsistent model lists.

The shared session hook now owns the bound machine's Provider subscription and
reads the exact id through the shared Provider atom. Both persisted and draft
composers pass matching machine/type overrides to model and command readers.
Missing/mismatched Providers expose no catalog. Keep the cache gate: weakening it
would revive models and commands from removed extensions.

Editing Pi extensions previously reset verification but allowed Save to close
without probing. Save now uses the existing revision-fenced live-verification
flow, including removal of the last extension. Unchanged edits still save without
a probe. The Provider must be persisted before the daemon accepts its id, so a
failed probe does not roll back the selection: the dialog stays open with the
error and retry. Changing the selection while a probe is pending cancels its UI
result; it cannot complete the newer save. Edit mode never uses background
Provider creation, even after clearing the final extension.

Behavioral coverage in `use-machine-flock-rows.test.tsx` mounts the actual shared
hook, reads the Provider from Flock, and verifies models and commands across
selection replacement/removal, refreshed catalogs and mismatched/missing bindings.
`agent-config-dialog.test.tsx` covers explicit scan/selection, save-time probing,
late responses, failed verification/retry and unchanged saves. All fixtures are
synthetic; no user extension is executed. The draft Pi Spec records the save
behavior and the hooks README explains the shared catalog ownership.
Validation: `pnpm check`, `pnpm format`, and `pnpm run docs check` passed.
[PR #1285](https://github.com/LodyAI/Lody/pull/1285).

### Pickers after the first turn (2026-10-08)

After the first Pi turn the persisted composer could still show only Role and
Agent. Two paths emptied its catalog while the stored row was correct. Session
creation re-parses `runtimeOverrides` through the message schema, which emits keys
in schema order and trims extension paths; probes and readers serialize the
Provider row's own order. With more than one override (`piPath` plus
`piExtensions`) the first session start overwrote the probe row with a suffix the
reader rejected. Separately, an absent Provider row (not yet materialized, or
dropped from the client cache) blanked even an ordinary Pi.

Override suffixes are now canonical (sorted keys, trimmed values) when stamped,
and the reader compares parsed overrides, so rows stamped in either order stay
readable without a re-probe. An absent Provider reads with no overrides: the
unchanged gate then serves only an override-free catalog, so plain Pi keeps Model
and Thinking while an extension-launched catalog stays hidden. A row bound to
another machine or type still exposes nothing. Coverage mounts the shared hook
with the row a session start writes (no extensions, extensions, extensions plus
a Pi binary in legacy schema order) and asserts both pickers.

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

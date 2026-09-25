# Built-in Pi provider

Status: draft
Translation: current

[中文](builtin-pi.zh.md)

Users can select Pi as a builtin provider. Lody downloads a checksummed runtime
containing the pinned public ACP adapter and its locked official Pi dependency.
The adapter is an isolated submodule, not part of the desktop dependency graph.
Windows native modules must come from a successful build of that exact revision.
Pi credentials remain on the execution machine or in the existing provider environment.

A repacked runtime may retain its source version while its artifact pins change.
Such a cache entry must not block daemon startup or be launched as the current
runtime. Reinstall through the normal checksum-verified path; malformed metadata
remains an error.

Startup cleanup and background update scans are best effort: log and skip each
failed runtime and continue with the others. Cache errors must not abort daemon
startup; actual launch and installation keep strict validation.

Registry generation excludes `pi-acp` from new-provider discovery. Existing registry
providers remain runnable until their owner explicitly confirms the chat landing card.
Startup must not auto-create builtin Pi while the same machine has a legacy Pi
provider; after confirmed migration the existing same-ID builtin row is reused.
Migration requires a target daemon advertising `builtinPi` version 1, changes the
same provider row to `builtin/pi`, and preserves its ID, machine, name, environment,
prompt and other fields. Deleted or already changed rows are not recreated or overwritten.
Partial failures can be retried without remigrating completed rows.
The daemon advertises `builtinPi` only when its Node version and platform satisfy
the pinned runtime manifest; an incompatible host must not offer migration.
The landing card appears when at least one eligible provider's machine advertises
that capability. Confirmation migrates only providers on supported machines;
unsupported machines do not block them and their providers remain unchanged until
a later confirmation after those machines become supported. Hide the card when no
providers can migrate. Once migration starts, the card may show disabled progress feedback.

This is provider migration, not native session conversion. The new adapter accepts
native Pi JSONL paths and cannot resume legacy `pi-acp` IDs. The confirmation card
states that users should start a new chat; stored conversation history is not rewritten.

## User-selected extensions

On machines advertising `piExtensions` v1, users can scan the default or saved
Provider's global Pi profile and explicitly select installed extensions, or add
absolute/`~/` paths manually. Scanning reads settings and package manifests through
Pi's own resolver without loading code, installing packages or reading project
configuration. New candidates are unchecked; rescanning does not change selections.
The scanned profile is shown because unsaved environment edits do not affect it.

The Provider's `runtimeOverrides.piExtensions` is the only durable selection.
Explicit testing and session startup pass those paths through `-e`, keeping
`--no-extensions`. Native subagents inherit the same selection so extension models
remain usable. This is consent to execute code with the user's permissions, not a
sandbox or a promise of arbitrary plugin/TUI compatibility. Missing paths and load
failures must not silently succeed. Changing or removing selections invalidates the
corresponding model catalog; running processes are not hot-reloaded.

Scan RPC accepts only an optional saved Pi Provider ID, never caller-supplied launch
arguments or environment. Local routes cannot fall back to cloud. The daemon
advertises support only when the checksummed runtime manifest declares
`piExtensionsProtocolVersion: 1` and the host can run it. Extension-enabled launches
require that pinned runtime rather than an older cached fallback. The currently
pinned artifact predates this protocol; enabling the UI requires publishing the
new artifact with Windows binaries built from the same source revision.

## Native history import

Local project history sync can import Pi sessions created on the same machine,
including those started in Pi's own terminal UI. The adapter lists Pi's native
session files for the project directory without starting Pi, and loading one
replays its current branch: user text and images, assistant text and thinking,
tool calls with their final status, and todo checklists where they occurred. The
importer keeps user text only and counts user images as dropped. Compaction summaries
and abandoned branches are not replayed. The imported session keeps the native
file path as its identity, so continuing it resumes that file; a missing file
fails the resume rather than starting an empty session.

Continuing a builtin Pi chat uses session resume, never load, so an ordinary
resume does not replay history. Import requires a published runtime containing
the adapter revision that advertises session list and load.

A new import binds to the machine's only Provider of the same type, and listing
and importing use that Provider's launch settings; an earlier unbound import binds
when that Provider lists it on a later sync. With none or several it stays unbound,
and an existing binding is never replaced. Refreshing an imported session loads it
the way continuing does: through its bound Provider, else the default launch.
Every import write records the model, mode and options that `session/load`
reports as the runtime selection of the last imported user turn; a newer Lody turn
keeps its own. An earlier import records it only when its source next changes. A
recorded model the bound Provider's catalog does not list still falls back to the
catalog default. This applies to every provider's history import; Codex's
read-only history method reports no selection.

Known limit: syncing again after continuing an imported session in Lody, or
while Pi is mid-turn, can report a sync conflict. Refresh requires the replay to
reproduce Lody's stored turns, but Lody-side attachments, subagent task cards,
retry and compaction activity, and locally handled commands are not in Pi's file.
This follows the shared importer design and also applies to other providers.

## Evidence

- `packages/shared/src/pi-provider-migration.ts`
- `packages/components/src/components/chat/pi-provider-migration-card.tsx`
- `apps/cli/src/agent/setting.ts`
- `scripts/package-pi-runtime.mjs`

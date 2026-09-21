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

## Evidence

- `packages/shared/src/pi-provider-migration.ts`
- `packages/components/src/components/chat/pi-provider-migration-card.tsx`
- `apps/cli/src/agent/setting.ts`
- `scripts/package-pi-runtime.mjs`

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
providers remain runnable. Startup must not auto-create builtin Pi while the same
machine has a legacy Pi provider. The chat landing action adds a separate `builtin/pi`
provider on the machine the user selected and leaves the legacy provider's identity,
launch configuration, environment, and existing Session bindings unchanged. Its stable
managed-provider ID makes retries idempotent; if that machine already has a builtin Pi
provider, the action must not create another or change the current default selection.
The managed provider does not inherit the self-managed provider's environment.
The daemon advertises `builtinPi` only when its Node version and platform satisfy
the pinned runtime manifest; an incompatible host must not offer migration.
The landing card appears when the selected machine has a legacy provider, advertises
that capability, and has no builtin Pi provider. Other machines and unsupported machines
remain unchanged. Once creation starts, the card may show disabled progress feedback.

Separate provider IDs isolate integration settings, not the Pi profile itself. Users
who need separate profiles can set `PI_CODING_AGENT_DIR` on one provider; Lody does not
move credentials or configuration files, and an independent profile may need its own
authentication and model configuration. Managed Pi still cannot resume legacy
`pi-acp` IDs, and stored conversation history is not rewritten.

## Evidence

- `packages/shared/src/pi-provider-migration.ts`
- `packages/components/src/components/chat/pi-provider-migration-card.tsx`
- `apps/cli/src/agent/setting.ts`
- `scripts/package-pi-runtime.mjs`

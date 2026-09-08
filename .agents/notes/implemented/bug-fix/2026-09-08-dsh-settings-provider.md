# Mount the DSH file settings provider

Status: implemented
Translation: pending

## Abstract

Lody's DeepSeek ACP composition installed the abstract settings interface but
never mounted a file provider, so edits to Harness user settings did not affect
its local model catalog. The extension now mounts upstream `dsh-settings-file`
and pins it to the same Harness release as the rest of the runtime closure.
A profile revision change invalidates old capability snapshots and generated
composition identities. The ACP entry requires `settings`, preventing its first
request from caching defaults before the provider finishes reading the file. Endpoint-driven catalog discovery remains unchanged;
local settings do not add models to an explicit endpoint's `/models` list.

## Decision and ownership

Use the upstream file provider instead of implementing a second settings parser
in Lody or hardcoding a temporary model catalog. The provider owns path resolution,
validation, watching, and persistence; the LLM plugin owns namespace semantics.
The extension owns composition and its exact package closure, while Lody keeps
launch supervision, the isolated npx cache, and capability refresh.

The provider reads `$DSH_HOME/settings.yaml`, defaulting to `~/.dsh/settings.yaml`.
An absent file retains defaults; malformed documents fail startup. User model arrays
replace the local catalog in full. The provider watches changes, but ACP model
choices are connection-cached, so users refresh capabilities and reconnect.
No user settings or credentials are copied into the generated Cordis file.

## Scope and alternatives

This implements the missing-provider fix only. Combining explicitly configured
model IDs with endpoint discovery is deferred: indiscriminately unioning local
defaults would advertise inappropriate models on arbitrary compatible endpoints.
Manual edits to generated configuration are not durable because the host
regenerates it. A custom ACP composition remains an independent workaround.

## Evidence and validation

- [Draft settings contract](../../../../specs/deepseek-harness-settings.md)
- [Extension profile](../../../../packages/acp-extension-dsh/src/profile.ts)
- [Profile regression tests](../../../../packages/acp-extension-dsh/src/profile.test.ts)
- [Host launch documentation](../../../../apps/cli/src/agent/README.md)

The extension build and 11 unit tests passed. A real-runtime ACP smoke test
checks custom catalog visibility on the first request, absent settings, malformed
YAML, non-mapping documents, and byte-preservation of the settings file. Its
preinstalled runtime contains 107 DSH packages, all at `0.1.1-rc.2`.
Public-boundary validation passed after initializing the required submodules.

The runtime probe also exposed an upstream limitation outside this fix: a valid
YAML document with a schema-invalid `llm-deepseek` section may retain composition
defaults rather than terminate. This change delegates namespace validation to
upstream; document parse failures are tested separately. Do not describe the
provider integration as fixing every plugin's invalid-configuration behavior.

`pnpm check` and `pnpm format` were attempted before commit but could not complete:
the checkout lacks full workspace dependencies (Claude adapter type checking and
workspace Prettier resolution fail). Extension build, unit/runtime tests, formatting,
document checks, and public-boundary checks passed.

## Integration

The DSH fix is based on its current main, preserving the already-merged independent
Plan Mode support. Lody therefore also advances `acp-extension-core` to the merged
0.1.1 contract required by DSH 0.1.2. The existing workspace override keeps Core
linked locally, so this changes no lockfile resolution.

- [DSH settings commit](https://github.com/LodyAI/acp-extension-dsh/commit/8c20b5de232cf45adea2e23145377b3edd021b13)
- [Upstream DSH Plan Mode](https://github.com/LodyAI/acp-extension-dsh/pull/12)
- [Upstream Core Plan Mode](https://github.com/LodyAI/acp-extension-core/pull/5)

The source integration does not upgrade an already running desktop or daemon.

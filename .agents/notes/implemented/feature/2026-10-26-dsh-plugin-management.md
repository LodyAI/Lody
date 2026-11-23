# DSH Provider plugin management

Status: implemented
Translation: current

[中文](2026-10-26-dsh-plugin-management.zh.md)

## Abstract

Lody previously replaced the DSH profile manifest on startup, losing dependencies
installed by the native CLI and allowing later package operations to prune them.
Startup now preserves user dependencies and configuration. Plugin management is a
local terminal command, `lody dsh plugin … --agent-config <id>`, which binds the
Provider home and native profile. There is no plugin inventory or management UI,
and package installation is never exposed through workspace RPC.

## Decision and boundaries

The final scope of [PR #1961](https://github.com/LodyAI/Lody/pull/1961) replaces the
unmerged UI/RPC implementation in PR #1932 with a thin native CLI wrapper. The user chose native
package-manager behavior over a separate Lody package catalog. Skills are outside scope.

- The local daemon returns only ids/names of builtin DeepSeek Providers on its machine,
  deduplicated across active workspaces. Selection does not query a cloud catalog or
  return saved Provider environment values. A missing id always prompts on a TTY;
  noninteractive invocation requires `--agent-config`. Unknown/nonlocal ids fail.
- The CLI runs the pinned DSH closure plus pinned pnpm with the selected Provider's
  `DSH_HOME` and `plugin --profile lody-acp`. Native arguments, caller cwd and terminal
  I/O are preserved. Registry, local-path and Git sources remain DSH/package-manager
  responsibilities. The wrapper rejects profile overrides.
- The child inherits the invoking terminal's environment, including package registry
  and Git authentication configuration, but never reads stored Provider credentials.
  This is explicit local execution, not a remotely callable installation service.
- Startup reconciles only generated base/host bundles and startup patch loading.
  User dependencies, unknown manifest fields, user bundles, pnpm workspace settings,
  lockfile and YAML patch survive. The host guard still enforces ACP, history roots
  and disabled telemetry.

## Ownership and failure recovery

The command owns the installer process through the shared Effect process Scope.
It holds the same Provider-home file lock as startup until child completion or
confirmed cancellation cleanup. SIGINT/SIGTERM abort the owned operation; normal
completion returns the native exit code. Different Provider homes remain independent.
The existing Promise launcher and file-lock Legacy application boundary are retained;
this change does not claim migration of daemon/session orchestration.

DSH owns package failure recovery. Lody does not restore only manifest/lockfile after
an unsuccessful install while leaving changed `node_modules`, which would manufacture
an inconsistent package state. Native logs and exit status remain visible. Existing
sessions need reconnecting to load changed plugins; the UI neither scans nor displays
installed plugins. External bare `dsh plugin` commands do not take Lody's lock and
should run while Lody is stopped.

## Verification scope

Behavioral coverage includes command argument forwarding and Provider selection,
local transport validators, machine/type filtering and credential-free discovery,
native subprocess cwd/home/environment and exit status, and startup preservation.
No test downloads or executes a third-party plugin. Packaged Windows installation
and live registry/Git authentication remain outside this verification scope.

On the updated base, five targeted CLI suites pass (79 tests) and two shared
transport suites pass (65 tests). Full `pnpm check` stops in the unchanged Codex
adapter build because the reused dependency installation lacks the ACP SDK's
`unstable` exports. The earlier baseline also had a recursive SSH fixture failure
with the local Git shim's `context_unreadable`; neither run establishes a green
full-repository check.

## Ablation evidence

Ablations start from `9d9b7a2a7` and change one candidate at a time. Passing tests
alone do not establish redundancy; each retained deletion also has an ownership
or type-level justification. The cleanup is replayed on remote merge `f7886d0ba`
and its focused suites rerun. The new local IPC response is still unmerged.

| Candidate | Evidence and decision |
| --- | --- |
| Nested discovery `success/error` fields | No failure producer exists; catalog exceptions already use the IPC error envelope. Remove the fields and client branch; real handler tests preserve success, catalog failure and wrong-machine rejection. |
| Fleet's repeated request-machine guard | Its sole production caller is the validated IPC handler. Remove the inner guard; deleting the authoritative outer guard makes the new boundary test fail. Provider-row machine/type filtering remains. |
| Single-use manifest-reader wrapper and exported schema | Inline the read/parse and keep the schema private; preservation and malformed-manifest tests pass. |
| `Number(exitCode)` | Effect's exit code is a branded number. Remove the conversion; native nonzero exit and cancellation tests pass. |
| Profile override guard | Temporary deletion fails the command test; restore it. |
| Reading the existing profile | Temporary deletion loses dependencies and overwrites malformed configuration; both regression tests fail. Restore it. |

File-lock ownership, process cancellation, platform spawn adaptation and manifest
validation remain intact. No evidence here authorizes removing those boundaries.

The remote merge removes the old Node executable overlay. The plugin entry now
reuses `prepareDeepSeekNodeEnvironment` after merging caller/launch env, matching
the system-Node contract. Its child-environment regression fails before the fix
and passes after it; cancellation still reaches the installer after a successful
probe. This integration repair is separate from the redundancy deletions.

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

The final scope of [PR #1932](https://github.com/LodyAI/Lody/pull/1932) replaces its
unmerged UI/RPC implementation with a thin native CLI wrapper. The user chose native
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

Full repository validation is not green: the unchanged recursive SSH submodule
fixture in `github-git-transport.test.ts` fails with the local Git shim's
`context_unreadable`; CLI and component type checks pass.

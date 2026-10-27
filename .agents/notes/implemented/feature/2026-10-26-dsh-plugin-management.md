# DSH Provider plugin management

Status: implemented
Translation: current

[中文](2026-10-26-dsh-plugin-management.zh.md)

## Abstract

Lody previously replaced the DSH profile manifest and package-manager configuration on
startup, losing plugin registrations installed by the native CLI. Startup now reconciles
only Lody's base and generated host bundle, preserving user dependencies, bundle order,
package-manager fields, lockfile, workspace configuration and YAML patch. Saved DSH
Providers expose registry-package installation, listing, updates and removal through a
capability-gated Machine RPC. Settings expose installation, listing and removal; the
update button is temporarily hidden at the user's request because available updates
are not detected. The RPC update operation remains supported. Skills are outside this change.

## Ownership and execution

The persisted Provider must belong to the execution machine and use builtin DeepSeek.
Requests contain its ID and a bounded registry package spec, never launch arguments,
paths, environment or a replacement home. Runtime packages and Lody host bundles cannot
be changed through this API. Local settings use local Machine RPC; remote settings reuse
the existing workspace transport. `dshPlugins: 1` gates both routes and the UI. New
Providers must be saved first; offline machines do not expose enabled operations.

The existing pinned npx/Node launcher runs `dsh plugin --profile lody-acp`; plugin
operations additionally provision pnpm 10.20.0 in that closure. The native package manager
owns bundle discovery, compatibility checks and activation. Plain packages remain visible
as installed but not enabled bundles. Launch reuses the login-shell PATH and then allowlists the environment; Provider API
credentials are not passed to package installation. The UI sends only explicit actions and advises reconnection after changes;
no active ACP connection is replaced or automatically refreshed.

Startup and package operations share a cross-process file lock keyed by Provider home.
The lock encloses generated bundle publication and manifest reconciliation, or the entire
package operation and resulting inventory. Independent Providers remain independent.
Malformed manifests fail without resetting user content. The host guard remains the final
layer preserving ACP, history and disabled product telemetry.

The new package-operation workflow composes native Effect with the existing FileLocks
and process services. SessionExecutionService executes it through the established Legacy
file-lock boundary; Promise-based launch preparation remains outside this native unit.
This is not a migration of the existing launcher or session execution owner. Process work
has a 240-second deadline and bounded output; process cleanup precedes typed failure
recovery and lock release. UI dismissal does not cancel an accepted operation. RPC waits
are bounded separately; after an ambiguous transport outcome the user refreshes before
retrying. Native process release defects are preserved, not reported as successful cleanup.

On ordinary process failure, restore the pre-operation manifest and lockfile under the
same lock. This preserves configuration, not a transactional copy of node_modules: a
partially completed package operation may require retry/repair. Installation diagnostics
stay on the owning machine under the profile's `.plugin-manager/logs`; the response does
not retain raw npm output. Direct external `dsh plugin` commands use upstream's separate
lock, so stop Lody before managing this profile outside its UI.

## Evidence and limits

Behavioral tests cover manifest/workspace/lockfile preservation across concurrent starts
and adapter upgrades, malformed configuration, serialization with package writes,
installation/update/removal inventories, failed-writer restoration, strict RPC inputs,
remote dispatch and UI success/failure states. Existing provider and Machine RPC suites
remain the owning coverage. A macOS smoke with pinned DSH 0.2.1-rc.2 verified native installation, automatic bundle
registration and removal of an isolated synthetic plugin while retaining the host layer.
It used no API credentials or model requests and is not a network-dependent unit test.
Windows and packaged Electron installation require platform smoke verification.

The submission `pnpm check` passed type/lint stages and all 616 component test files.
CLI validation exposed a missing capability expectation (corrected) and a native Git
recursive-submodule fixture failure with `context_unreadable`; that transport is outside
this change. Full green validation is not claimed. Targeted plugin suites, static
boundary checks and documentation checks pass. An earlier run also hit a V8/Wasm
code-reclamation SIGTRAP, which did not recur in the submission run.

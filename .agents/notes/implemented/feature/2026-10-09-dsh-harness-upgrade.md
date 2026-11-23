# Upgrade the DSH runtime to Harness 0.2.0-rc.2

Status: implemented
Translation: current

[中文](2026-10-09-dsh-harness-upgrade.zh.md)

Provider PR: [acp-extension-dsh #28](https://github.com/LodyAI/acp-extension-dsh/pull/28)
Host PR: [Lody #1353](https://github.com/LodyAI/Lody/pull/1353)

## Abstract

The requested latest Harness upgrade moves the adapter from 0.1.5-rc.2 to the
npm `latest` release 0.2.0-rc.2; the separate alpha channel is not selected.
The upgrade replaces removed preset/settings APIs while retaining model settings,
preset identities and native conversation restoration. The host now recognizes
versioned session artifacts so raw roots remain raw after native format migration.
Real-runtime probes pass for new and upgraded JSONL/zstd sessions; full desktop
packaging and native Windows execution remain unverified in this checkout.

## Decision and implementation

- Rebuild the 286-specifier runtime closure from published packages, with exact
  Harness/Cordis/Cosmokit/pi-ai/Schemastery versions and profile revision v17.
  Normal npm 10 installation succeeds without force or peer-dependency overrides.
  Registry tags were checked on 2026-10-09: latest/next 0.2.0-rc.2, alpha 0.2.1-alpha.2.
- Register the shipped declarative presets through the new native registry in the
  profile's module-resolution scope. Vendor the dsh-web-app preset patches with
  only the outer insertion envelope removed; creator skills come from the pinned
  dsh-agent-preset package. Preserve legacy user declarations and default selection.
  Disable duplicate host tool rows; mount the native inspection dependencies needed
  by Creator mode. Await Loader settlement before the first ACP capability query.
- The removed settings-file service cannot be replaced by merely mounting settings:
  its new implementation renames settings.yaml and imports it into the active profile.
  Lody profiles are generated/content-addressed, so that migration would strand settings
  on a later upgrade. Disable it and read legacy model sections into native Config,
  preserving the shared file and configured preset default. Invalid documents reject
  initialization. Settings are startup snapshots; reconnect to apply edits.
- Disable the newly inherited account-backed provider and account component, in
  addition to existing telemetry and product inventory exclusions. Keep API-key
  routes and credentials in their existing native/host ownership.
- CLI publish and Electron after-pack checks follow the new flat `presets/<id>.yml`
  layout. CI caught two stale assumptions: the removed `dsh-agent-presets` package
  in the launcher test and nested `<id>/agent.cordis.yml` asset checks. The test now
  requires the native preset registry and verifies generated profile files; native
  profile probes own preset/configuration behavior instead of source-string checks.
- Recognize both legacy and session.vN JSONL/zstd filenames during read-only host
  encoding discovery. Native write-open owns supported migrations to V4 and retains
  predecessors; do not implement compression conversion or automatic downgrade.

This supersedes the file-provider mechanism in the
[settings note](../bug-fix/2026-09-08-dsh-settings-provider.md), while preserving its
first-request catalog and source-document guarantees. It extends the
[restoration decision](2026-10-09-dsh-session-restore.md). The
[settings Spec](../../../../specs/deepseek-harness-settings.md) remains draft.
The earlier Core capability audit was against 0.1.5-rc.2; reassess its native
evidence before implementing further interfaces on this new runtime.

## Verification and limits

- Adapter build and 42 unit tests; real profile tests cover all four preset switches,
  model/permission/preset restoration, custom preset/default compatibility, invalid
  settings, untouched documents and missing-credential failure before provider I/O.
- Native restore probes cover cold load/resume, interrupted tails, identity/context
  continuation and incremental accounting in both encodings. Additional cases create
  sessions with 0.1.5-rc.2 and restore them with 0.2.0-rc.2. Native fork/compaction
  replay and question/approval ownership probes also pass without real model calls.
- The 14-test host runtime suite runs with an isolated Vitest configuration and an alias to
  the built adapter, including versioned/mixed encoding roots and the synthetic
  Windows forwarding boundary. It does not exercise the Windows native binaries.
- CI follow-up validation uses a standalone clone with frozen-lockfile dependencies:
  64 launcher/runtime tests, the complete CLI build (including preset copy/import
  checks), desktop CLI sync/application build, root format, docs check, i18n and all
  three import/platform/public boundary guards pass. Removing `standard.yml` also
  makes the published-bundle gate fail as expected.
- Root `pnpm check` passes typecheck/lint, then stops on the unchanged recursive SSH
  fixture in `github-git-transport.test.ts`: the local Lody Git wrapper reports
  `context_unreadable`. The CLI group otherwise has 3,577 passing tests and four
  skips. This is not a passing full-repository check; desktop E2E scenarios and
  installer after-pack execution remain unverified locally.

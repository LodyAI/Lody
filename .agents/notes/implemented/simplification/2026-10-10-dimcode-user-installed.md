# User-installed builtin Dimcode

Status: implemented
Translation: current

[中文](2026-10-10-dimcode-user-installed.zh.md)

## Abstract

Builtin Dimcode previously downloaded a pinned npm package, leaving version ownership
with Lody. It now follows Bub: launch the user-installed `dimcode acp` and let the user
manage compatibility and upgrades. Missing commands fail setup with a copyable `npm install -g dimcode` command;
there is no download fallback. This shares the user's Dimcode configuration and state,
so it is not a private-runtime isolation scheme.

## Decision

This replaces the runtime choice in the [original integration](../feature/2026-09-22-dimcode-builtin-acp.md).
The [draft Spec](../../../../specs/dimcode-builtin-acp.md) defines current intent.
A private managed artifact was considered but would keep version ownership with Lody.
The selected contract instead reuses the installed CLI, preserving provider IDs and
leaving old npm caches and legacy registry launch contracts intact.

The capability source changes to `builtin-dimcode:local-acp` to invalidate the old
pinned-runtime cache. Later upgrades need explicit capability refresh, like Bub.
Only successfully verified setup is published; missing executables and unsupported ACP
subcommands remain retryable with the installation command. The UI shows a short missing-command sentence
with the command and an adjacent copy button, without a long explanation or external install-guide link.

The [upstream CLI documentation](https://www.dimcode.dev/en/docs/cli/) documents
`DIMCODE_DISABLE_AUTOUPDATE=1` and `DIMCODE_AUTOUPDATE=0`. Both are applied only to
Lody's Dimcode child process so startup does not request updates of the shared installation.
The user's terminal environment and Dimcode home are unchanged.

## Validation

All 69 CLI launch/setup tests passed, covering direct command resolution, extra arguments,
auto-update environment precedence, successful publication and unpublished failures.
CLI typecheck passed. Real Dimcode execution, full build and authenticated prompts remain unverified.

The real provider row/dialog suites cover the installation command, successful and failed
clipboard writes, unrelated verification errors, and retry/refresh: all 51 tests passed.
Scoped type-aware Oxlint completed with zero errors (74 warnings); i18n and diff
whitespace checks passed. Root `pnpm format` passed. Root `pnpm check` remains blocked
by missing dependencies in `packages/ignore`; components typecheck is blocked by
missing Electron dependencies and related type errors outside the changed files. Components dependencies
were installed from the local pnpm cache after initializing the six root-workspace ACP
submodules and building Core/DSH. Public-boundary checking passed. Documentation checking
retains six pre-existing missing Kimi/Pi submodule links, with no new errors.

`ProviderSetupRow/DimcodeNotInstalled` renders the real component with synthetic setup data.
Chrome screenshot coverage uses 900px Chinese/light and 390px Chinese/light and English/dark.
All three renders had no page exceptions or horizontal overflow.
The narrow layout's existing reserved action columns still truncate the provider name;
that separate issue is unresolved. This verifies the component, not the packaged app or
real machine installation. Screenshots are temporary review artifacts, not committed files.

Pull request: [#1380](https://github.com/LodyAI/Lody/pull/1380) (draft).

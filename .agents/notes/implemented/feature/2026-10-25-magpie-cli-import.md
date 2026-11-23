# Headless Magpie provider import

Status: implemented
Translation: current
PR: [#1866](https://github.com/LodyAI/Lody/pull/1866)

[中文](2026-10-25-magpie-cli-import.zh.md)

## Abstract

Server users could not invoke desktop-only Magpie import or persist its gateway
metadata with the generic provider CLI. `agent-config import-magpie` now creates
all seven supported provider mappings on the invoking machine, with optional
subsets or the existing import link. It reuses daemon setup and native catalog
preparation, preserves existing providers, and retries failed setup tasks.
Import confirms configuration durability, not runtime readiness or inference.

## Decision and boundary

The user requested server-side one-command import. This extends the explicit
consent boundary in the existing [draft Spec](../../../../specs/magpie-provider-import.md),
without approving that Spec or weakening desktop link confirmation. Unlike a
remote machine selector, server-local execution keeps loopback ownership clear.
It uses the existing cloud workspace command runtime; OSS local-only command
support is separate work. No new protocol, backend or arbitrary credential import
is introduced. The [earlier decision](2026-10-09-magpie-provider-import.md) still
owns runtime isolation and public token handling.

The command validates all requested capabilities before writes, serializes CLI
imports per workspace/machine with the existing file-lock facade, and synchronizes
the machine catalog before deduplication. It writes the existing Flock schemas and
flushes before publication. Failed upload leaves durable rows and reports
`synced: false`; rerunning preserves matching provider/setup IDs and retries failed
setups with their existing configuration. Active or awaiting-auth setups are not
restarted. The daemon retains installation, verification and cancellation ownership.
Concurrent desktop authoring remains governed by the existing Flock behavior;
the CLI lock only serializes CLI imports on this machine.

Effect feature/fix assessment: the command framework and Repo manager remain
Promise-based. The synchronous import reducer stays ordinary TypeScript and uses
the existing native file-lock Legacy boundary. Migrating workspace ownership would
pull in the unfinished Repo consumer chain and is deferred, per the selection guide.
No runtime lifecycle or migration ledger boundary changes.

## Validation

The existing command suite exercises real Flock writes for all seven mappings,
repeat imports, partial prior imports, failed-setup retries, invalid endpoints,
link target restrictions and capability preflight. Command tests check invoking
machine selection and durable state after upload failure. Runtime catalog tests
remain unchanged. No real vendor inference or packaged Linux deployment was run.

Validation on this working tree: 52 tests across agent-config, Magpie runtime and
provider setup passed; CLI typecheck, changed-file Oxfmt/Oxlint and public-boundary
checks passed. Dependencies were reused from the installed workspace. Full
`pnpm check` stopped at the DSH submodule build because its dependencies were absent;
`docs check` still reports six pre-existing links into uninitialized Kimi/Pi
submodules. No package versions or submodule pins were changed.

The bilingual Magpie site guide documents server setup, target selection and result states, with sidebar and CLI-reference entries.

Site validation: content generation, 59 site tests and the production build passed. Both prerendered Magpie pages and the CLI-reference links were checked in the generated HTML.

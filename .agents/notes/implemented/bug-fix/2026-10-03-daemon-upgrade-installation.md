# Bind daemon updates to a stable recovery owner

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1228
Supersedes: [Windows npm shim](../../archived/bug-fix/2026-09-08-windows-daemon-upgrade.md)

[中文](2026-10-03-daemon-upgrade-installation.zh.md)

## Abstract

A daemon launched from an npx cache could install successfully while respawning its
old entry; installed and running identity are different facts. Managed updates use
signed immutable releases beneath a fixed SEA watchdog. That root retains the Host
lease and observes the actual replacement before committing an operation. A separate
ordinary Node increases initial download size; uncertain termination blocks recovery.

## Decision and rationale

The earlier verified npm-bin handoff fixed destination selection but still depended
on the user's npm environment, native installation scripts and lease handoff between
owners. Windows shims additionally require an interpreter; quoting cannot solve
installation ownership. PATH lookup and modifying shared global packages remain
unsuitable update mechanisms.

The fixed entry reads durable selection and operations in the existing data directory.
It starts verified physical CLI files using an independently cached official Node.
External Agent JS, keychain helpers and Workers require ordinary Node: SEA executes
its embedded entry, not arbitrary scripts. Native modules retain their signed bytes.
Each SEA also embeds Node, so initial transfer includes both runtime images. Reusing
the existing watchdog avoids a new Rust launcher and overlapping restart owners.

All old npm watchdogs need an explicit local migration and external service-entry
correction; downloaded code cannot retroactively teach the old process this protocol.
Arbitrary user services are never rewritten. Fixed-entry replacement stays an explicit
installer operation rather than creating another self-replacement recovery cycle.

Preparation keeps the old Worker serving. Only confirmed drain and termination allow
a successor writer. An operation ID binds one target and its choices. Download ACK
is not application evidence: exact running identity is required. Rollback persists
the retained selection as well as its outcome. Network loss does not prove local
failure. Windows automatic updates and encrypted lifecycle operations remain unsupported
until their specific ownership and authorization boundaries are implemented.

## Evidence and limits

The [installation contract](../../../../specs/daemon-upgrade-installation.md),
[packaging guide](../../../../apps/cli/scripts/sea/README.md),
[signed-release tests](../../../../apps/cli/src/lib/managed-daemon-release.test.ts) and
[native fixture](../../../../apps/cli/scripts/sea/native-acceptance.mjs) cover different
boundaries. Artifact probes do not establish full Agent acceptance or production
signing. POSIX group tracking is cooperative process ownership, not a container
against hostile children escaping their groups.

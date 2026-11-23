# Automatically refresh Grok runtime pins

Status: implemented
Translation: current

English | [中文](2026-09-25-grok-pin-refresh.zh.md)

## Abstract

Grok mirroring could download a new version while validating it against old hardcoded source hashes. The CLI and mirror also duplicated archive pins. Both now consume one versioned manifest, and version changes derive all six targets from official npm metadata before production upload/readback permits an atomic manifest update. Existing 1.0.40 CLI pins were migrated without changing their runtime bytes and verified against real upstream packages; production upload was not run for this change.

## Decision

The adapter selects the version; `grok-runtime-manifest.json` owns source integrity,
archive and executable SHA-256 values and sizes. The CLI rejects version drift.
The mirror validates exact package identity, version, official URL and SHA-512,
then reproduces each decompressed native archive twice. All six targets must succeed
and match canonical production readback before writing new pins. Dry runs,
print-only runs, skipped uploads and custom channels never write the manifest.
A conflicting immutable object or same-version source hash fails closed.

This extends the [artifact-first runtime refresh](2026-09-17-managed-runtime-refresh.md)
without changing runtime version selection. Codex and Claude already refresh their
manifests; Kimi and Pi derive theirs from reproducible source builds. Automatically
accepting any downloaded bytes after a mismatch was rejected because that would
remove the source-integrity boundary.

## Verification

All six official Grok 1.0.40 packages passed source verification, reproducible repack,
and existing archive/executable pin verification with `--skip-upload`. Runtime
manifest tests and the CLI runtime suite passed (57 tests), as did CLI typechecking
and documentation checks. A stale-manifest fixture regenerated all six targets,
rejected partial refresh, and left the production manifest untouched with
`--skip-upload`. Production upload/readback and authenticated runtime execution
were not performed.

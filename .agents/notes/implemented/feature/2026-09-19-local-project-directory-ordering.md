# Local project directory ordering and metadata

Status: implemented
Translation: current

[中文](2026-09-19-local-project-directory-ordering.zh.md)

## Abstract

`local-project/list-dir` previously truncated filesystem iteration before sorting, so limited results were not the first entries in the advertised order. The protocol now negotiates directory ordering and optional stat metadata through a versioned machine capability, sorts the complete browsable directory before applying the limit, and emits `mtimeMs` and `size` only when requested. The opt-in response preserves the strict legacy payload for older clients, at the cost of reading every eligible child before truncation.

## Decision

The request accepts `sort` (`name`, `mtime`, or `size`, direction, and directory grouping) and `include: ['stat']`. The daemon already stats every accepted child for file-type and containment checks, so those values also drive sorting without an additional filesystem call. A new `localProjectDirectoryMetadata` machine capability keeps clients from sending the strict-schema extension to older daemons.

## Verification

Shared protocol guards and capability tests pass. CLI boundary coverage verifies that size ordering occurs before truncation and that requested metadata is returned. Full repository checks remain to be run before publication.

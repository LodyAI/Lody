# Preserve MCP selection in batch-created Sessions

Status: implemented
Translation: current

[中文](2026-10-26-mcp-batch-create-selection.zh.md)

## Abstract

`lody_session_create_many` accepted MCP server selections but dropped them while
converting batch items to single-create commands, causing explicit selections to
fall back to target defaults. The batch-to-single conversion now carries the
optional field only when it was supplied, preserving the distinction between an
omitted value, `[]`, and a non-empty selection. A boundary test observed the
accepted canonical command, frozen dispatch configuration, and materialized
create configuration; removing the field propagation made that test fail.

## Findings

- `SessionCreateBatchItemShape` already accepts optional `mcpServerIds`, and the
  MCP README defines omission as target defaults and `[]` as selecting none.
- Batch defaults are merged with item values before conversion. The converted
  single input fed canonical command and dispatch resolution but omitted the
  selection, so the accepted Operation could not freeze the requested servers.
- `buildMcpRunConfigCanonicalCommand` intentionally owns ACP controls and does
  not include MCP selection; the missing field belongs in the explicit
  batch-to-single mapping.

## Decision

Copy `mcpServerIds` into the single-create input when it is not `undefined`.
This one conditional property preserves ordinary default resolution and an
explicit empty selection without introducing another helper or state. The
existing resolved-command and frozen-target configuration paths then carry the
same selection through acceptance, recovery, and materialization.

## Verification

The regression test calls the real batch creation handler with three items:
omitted, empty, and `['server-a', 'server-b']`. It checks the accepted canonical
command, frozen per-target dispatch config, and config passed to session
materialization. With the propagation line temporarily removed, the canonical
command contained three omitted values and the test failed; restoring it made
the test pass. No temporary change is part of the final diff.

The test ran with Node 26.12.1 by reusing dependencies already installed in a
separate worktree; the required Node version was fetched into npm's isolated
cache. The PR's full check status records any remaining environment limits.

## Review

[Draft PR #1907](https://github.com/LodyAI/Lody/pull/1907) includes the red and
green terminal captures and the focused regression evidence.

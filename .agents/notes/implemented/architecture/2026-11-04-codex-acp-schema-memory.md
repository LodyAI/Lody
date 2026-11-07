# Defer Codex ACP validation schemas

Status: implemented
Type: architecture
Translation: current
PR: https://github.com/LodyAI/acp-extension-codex/pull/78

[中文](2026-11-04-codex-acp-schema-memory.zh.md)

## Abstract

Each Codex adapter process constructs ACP SDK validation objects for both protocol versions at startup. The bundled Node/Electron adapter creates unused schemas on first validation instead. V1, V2, session isolation and protocol behavior remain unchanged.

## Decision

The adapter build defers generated V1 and V2 schemas in ACP SDK 2.0.2 with Zod's cached lazy schema. NES exposes object schemas that callers can extend, so those objects and their transitive schema dependencies keep their original types. Other SDK versions use their own generated code. This changes only the bundled adapter; the SDK installation and Bun executable build remain unchanged.

The alternative of sharing an adapter across sessions changes their process boundary. Deferring construction preserves the existing boundary and retains every protocol handler.

## Measurements

On macOS arm64 with Electron 44.9.3 and Codex 0.164.0, six independent Codex adapter/native pairs completed short synthetic conversations against a local model fixture. After 60 seconds idle, their combined macOS footprint fell from 397 MiB to 310 MiB using Lody's adapter packaging. This is a process-group measurement, not the entire desktop.

In paired local latency experiments, the first V1 permission validator added about 0.8 ms at the median, and the first V2 initialization validator about 1.3 ms. The first response chunk in the synthetic conversation was approximately 20 ms in both variants. These measurements do not include a remote model or desktop UI.

## Verification

The adapter's [schema bundle tests](../../../../packages/acp-extension-codex/scripts/lazy-acp-schemas.test.mjs) compare generated V1 and V2 parse results and errors, exercise NES object extensions, and verify first-use initialization. Real Codex acceptance uses synthetic sessions and the local model fixture.

# Load only ACP v1 in Lody's Codex adapter

Status: implemented
Type: architecture
Translation: current

[中文](2026-11-03-codex-v1-adapter-memory.zh.md)

## Abstract

Each retained Codex session runs an adapter process. Lody uses ACP v1, but the
general adapter entry also loaded ACP v2 protocol definitions in every process.
The bundled Lody entry now connects the existing v1 handlers without those v2
definitions. Each session keeps its own adapter and Codex processes.

## Decision

The SDK's general protocol router imports both versions' schemas even when the
client uses v1. The Lody entry uses the adapter's existing v1 handlers directly;
shared response delivery and session setup remain in the common router core.
The adapter's standard entry continues to use the general router. Codex's native
app-server v2 protocol is separate from ACP v2 and remains unchanged.

## Verification

The [history transport suite](../../../../packages/acp-extension-codex/src/__tests__/ReadSessionHistoryTransport.test.ts)
exercises the Lody entry's router alongside the existing routes. The
[prompt harness](../../../../packages/acp-extension-codex/src/__tests__/CodexACPAgent/v2-prompt-harness.ts)
uses that router for its v1 conversation, cancellation, approval, and recovery cases.
The [entry build test](../../../../packages/acp-extension-codex/src/__tests__/LodyEntryBuild.test.ts)
builds the Lody entry with the ACP v2 SDK unavailable.

On macOS arm64, ten independent synthetic Codex sessions using a local model
service had a combined adapter and native-process physical footprint of 676.2 MiB
with the standard entry and 537.3 MiB with the Lody entry, after 120 seconds idle
without forced garbage collection. This measures the Agent processes, not the
full desktop.

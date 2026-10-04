# Classify MCP sync failures by acceptance state

Status: implemented
Translation: current

[中文](2026-09-27-mcp-sync-retry-classification.zh.md)

## Abstract

A transport outage could reach MCP as a nonretryable internal error or command refusal, while generic sync advice told callers to resume Operations that had never been accepted. Machine document sync failures now carry a typed retryable error, failed fetches map to retryable sync unavailability, and preacceptance sync failures tell Operation callers to resend the full request. Other tools receive a generic retry message without an operation ID. The classification remains limited to known fetch and sync producers; unrelated errors keep their existing behavior.

## Decision and evidence

Issue #400 reports four observed outputs. The MCP boundary treated an exact `TypeError('fetch failed')` as `INTERNAL_ERROR`, and `syncMachineFlockDocsForRead` propagated a plain error into the `COMMAND_REJECTED` fallback. `WorkspaceSyncUnavailableError.toLodyError()` replaced its instance message with one shared instruction that mentioned `operationId` even for `session_list`. All four asynchronous Command entry points sync workspace metadata before Operation acceptance.

The change types the machine document sync boundary, recognizes the exact fetch error at the MCP boundary, and separates generic sync advice from preacceptance Command advice. Batch item validation retains per-item failure reporting. A broader classifier based on arbitrary message substrings would risk converting programming errors into retryable failures, so this change does not do that.

## Verification and limits

The regression tests cover the machine document boundary, MCP error payloads, and preacceptance retry advice. No live network outage was reproduced. The separate issue #398 concerns whether local-project freshness reads should block session creation; this note concerns classification when a sync is required and fails.

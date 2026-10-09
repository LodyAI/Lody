# Show rejected model selections in the GUI

Status: implemented
Translation: current

[中文](2026-10-09-model-rejection-gui-warning.zh.md)

## Abstract

Codex and Claude model rejections were hidden in debug logs, so a resumed turn could
use the previous model without explaining the failed selection. Model rejections
now enter the existing durable GUI warning path for every provider, including
selections supplied through a model config option. The active model remains the
agent-confirmed value. Warning delivery remains asynchronous and does not stop
the turn.

## Decision

This partially replaces the CLI warning policy: model selection failures are
visible, while Codex/Claude effort, Fast and Plan mismatch suppression remains.
The [orchestration Spec](../../../../specs/session-orchestration.md#runtime-model-rejection)
records the changed guarantee as draft. The
[per-model capability decision](../architecture/2026-09-29-per-model-acp-capability-row.md)
still owns effort and Fast discovery and validation.

`applyAcpSessionRunConfig` records both scalar `modelId` and model config-option
rejections in `warningSelections`. `MessageHandler` already persists those
selections as `agent_warning`; the existing GUI warning view renders the notice.
Rejected selections never replace the model in the runtime patch. This change
does not expose raw provider error payloads or alter turn execution policy.

## Verification and limits

The owning applier suite covers both selection forms across providers, scalar
precedence, and preservation of the active model after rejection. The existing
MessageHandler history-gate suite verifies the real SessionDocument receives a
GUI warning after the driving user turn. Both suites passed locally (21 tests),
along with scoped Oxfmt and Oxlint checks. The temporary runner reused sibling
dependencies and disabled unused Roost imports; it exercised the real Loro history
path. Full CLI type checking remained blocked by missing adapter submodules and
incompatible borrowed workspace dependencies. No packaged GUI acceptance is
claimed. Transport errors swallowed by `withTransportRetry` remain a separate
unresolved failure path.

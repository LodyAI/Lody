# Preserve selected-model validation in frozen Session creates

Status: implemented
Translation: current

[中文](2026-09-28-frozen-create-model-validation.zh.md)

## Abstract

Four accepted Session creates repeatedly failed before reaching the target because recovery checked a frozen `reasoning_effort` against the wrong model's capability snapshot. The frozen config now retains ids validated against the selected model, and deterministic selection failures end the item without retrying. Transport uncertainty still retains its bounded retry. A live cross-machine reproduction remains unverified.

## Decision and evidence

The raw source daemon log supplied in [issue #956](https://github.com/LodyAI/Lody/issues/956#issuecomment-5861823758) identified 56 `Unknown ACP config option` materialization failures. The source machine had probed `gpt-6-sol`, which offered no effort option, while the requested `gpt-5.6-sol` accepted `medium`. Acceptance validated against the requested model, but its frozen config lost `validatedConfigIds`; recovery then rejected the otherwise valid id. The earlier [diagnostic note](2026-09-27-session-create-materialization-failure.md) could only preserve the error and was written before the raw logs arrived.

Persist the validated ids with each effective target dispatch config, including batch creates. Recovery skips only those ids during the probed-model snapshot check. This retains the accepted concrete dispatch settings without re-reading mutable requester defaults or a Role catalog. A typed selector validation error is terminal `COMMAND_REJECTED`; ambiguous target writes and sync failures still retry.

## Verification and limits

The Session config, Operation store, and coordinator tests cover the model mismatch, persisted metadata, and terminal failure. They do not demonstrate a live macOS cross-machine create.

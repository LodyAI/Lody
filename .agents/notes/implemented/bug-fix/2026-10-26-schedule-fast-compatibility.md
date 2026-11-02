# Normalize legacy Schedule Fast values without a probe declaration

Status: implemented
Translation: current

PR: https://github.com/LodyAI/Lody/pull/1911

[中文](2026-10-26-schedule-fast-compatibility.zh.md)

## Abstract

Legacy Schedule booleans for Fast could survive when the cached probe described another model and omitted Fast, then fail ordinary Session validation. Schedule normalization now recognizes the shared semantic IDs `fast` and `fast-mode` when the probe has no entry, while preserving explicitly declared selects and unrelated string options. Only exact `"true"` and `"false"` values change, and stored definitions remain untouched so their authorization fingerprints stay valid.

## Decision

Schedule v2 preserves ACP strings and booleans. Existing projection converted legacy literals only for options declared boolean by the cached probe. That was insufficient for Fast because its IDs are stable semantic controls shared across models, while a capability probe reports only the probed model's controls. Use `isAcpFastModeConfigId` as the existing ID contract: convert exact boolean literals for a declared boolean option, or for a Fast ID absent from the probe. If the same Fast ID is explicitly declared as a select, preserve its string. Other select and unknown option strings are unchanged.

This deliberately does not coerce every value named `"true"` or `"false"`, infer Fast from a display name, or declare that the target model supports Fast. The ordinary target-model validator and agent remain responsible for support. It also does not rewrite the Schedule document or ledger: fingerprints continue to cover the authorized persisted definition.

## Evidence and validation

Issue #1732's synthetic shape has target model `opus`, a probe without Fast, and saved `fast: "false"`. The production `prepareSessionInput` regression failed before the change with `Config option "fast" expects a boolean or on/off value.` and passed after normalization. Coverage also checks both Fast aliases and both boolean values, explicit select on ID `fast`, unrelated select strings, and the existing fingerprint-preservation behavior.

The before/after terminal recordings attached to [PR #1911](https://github.com/LodyAI/Lody/pull/1911) show the same synthetic test command and input against baseline `91fa467a205c` and the fixed commit. These fixtures do not contact a provider or alter a stored Schedule.

The simpler alternative—coercing every exact boolean-looking string—would corrupt ordinary select values. Requiring the probe to declare boolean reproduces the reported failure. The retained ID-specific exception is limited to the two semantic Fast IDs and does not bypass target validation.

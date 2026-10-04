# Validate frozen Session create options against their target model

Status: implemented
Translation: current

[中文](2026-10-02-session-create-target-model-validation.zh.md)

## Abstract

A Session create accepted a semantic reasoning selection for a non-probed model but rejected the same concrete options during durable materialization. The probe's effort list describes a different model, so the rejection prevented Session creation until the Operation deadline. Create validation now recomputes target-model effort and Fast exemptions from the stored model and options, using the same policy as chat validation. Existing frozen Operations and Role creates benefit without a storage migration; unknown target capabilities remain subject to runtime validation.

## Decision

Issue [#1215](https://github.com/LodyAI/Lody/issues/1215) identifies the mismatch between semantic acceptance and concrete replay. `resolveEffectiveSessionCreateDispatchConfig` merges the semantic resolver's validated IDs with `validateModelDependentTurnConfigOptionValues` before checking snapshot options. Top-level model selection takes precedence over the model option, matching dispatch. Declared target constraints and unrelated option validation remain enforced.

The integration with [#956](https://github.com/LodyAI/Lody/issues/956) retains its existing optional frozen validation IDs for wire/storage compatibility, but recomputes model-dependent validation even when no such IDs were stored. This also covers older Operations and concrete Role selections without a new schema field or migration. The surrounding deterministic validation-error classification remains intact, so invalid target selections still produce `COMMAND_REJECTED` instead of retrying until the deadline. This restores the existing model-dependent validation contract; no Spec intent changes. The composer menu is unchanged.

The main-branch integration preserves explicit raw mode/model precedence over inherited scalar selectors and legacy Plan conflict rejection. Target-model validation still runs before the inherited configuration is merged.

## Verification

The owning Session command suite exercises actual `prepareSessionInput` with a synthetic machine capability row: semantic creation followed by JSON-frozen concrete replay, Role-style model options, rejection for probed or declared invalid effort, and unknown-option rejection. Live Devin ACP and daemon retry scheduling are not exercised; the shared preparation boundary is covered.

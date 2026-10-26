# Keep automatic title generation on the provider model

Status: implemented
Translation: current

[中文](2026-10-26-title-generation-provider-model.zh.md)

## Abstract

Generic ACP title generation inferred a model from the last advertised option, so catalog ordering could silently move an isolated title session to a more expensive model such as Amp Ultra. The runtime now leaves model selection to the provider unless the user saved an explicit title model; existing builtin Codex, permission, and reasoning defaults remain intact. Capability absence produces no model override. The shared behavior suite passes; the CLI integration suite could not start because this nested checkout lacks the Claude SDK dependency inside its isolated adapter submodule.

## Decision and evidence

`computeTitleGenerationDefaults` supplied a `model` value using the final catalog entry, even when `currentValue` named another model. The isolated title generator applies every supplied value through `applyTitleConfigOptions`, and the settings dialog also merged inferred defaults into its saved title configuration. This made an ordering detail act like a user preference.

Generic providers now omit model values from inferred defaults. The settings dialog therefore has no inferred model to save, while an explicit persisted title model still follows the existing application path. Builtin Codex keeps its documented `gpt-5.6-luna` default. Mode and reasoning defaults are unchanged; they remain independent of model selection. With no model capability, the generic default object contains no model key.

The alternative of preserving last-item selection was rejected because ACP option order carries no preference or cost semantics. The change does not alter stored explicit choices or the main conversation's model.

The deterministic shared suite covers catalog order differing from the current model, absent model capability, generic provider behavior, and the builtin Codex exception. The CLI test also covers preserving a current Amp model and applying an explicit legacy model selection. A local baseline run failed four model-default assertions before the implementation change; the final shared suite passes 19 tests. The CLI suite was attempted but could not load because the isolated Claude adapter lacks its nested SDK manifest in this checkout.

## Verification

- Shared: `vitest run packages/shared/tests/title-generation-defaults.test.ts` — 19 passed.
- CLI: `vitest run src/agent/title-generator.test.ts` — blocked before test collection by missing `packages/acp-extension-claude/node_modules/@anthropic-ai/claude-agent-sdk/manifest.json`.
- Pull request: pending.

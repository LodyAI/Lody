# Keep automatic title generation on the provider model

Status: implemented
Translation: current

[中文](2026-10-26-title-generation-provider-model.zh.md)

## Abstract

Generic ACP title generation inferred a model from the last advertised option, so catalog ordering could silently move an isolated title session to a more expensive model such as Amp Ultra. The runtime now leaves model selection to the provider unless the user saved an explicit title model; existing builtin Codex, permission, and reasoning defaults remain intact. Capability absence produces no model override. Shared, CLI title-generation, and settings behavior suites pass with the lockfile dependencies in an isolated validation worktree.

## Decision and evidence

`computeTitleGenerationDefaults` supplied a `model` value using the final catalog entry, even when `currentValue` named another model. The isolated title generator applies every supplied value through `applyTitleConfigOptions`, and the settings dialog also merged inferred defaults into its saved title configuration. This made an ordering detail act like a user preference.

Generic providers now omit model values from inferred defaults. The settings dialog therefore has no inferred model to save, while an explicit persisted title model still follows the existing application path. Builtin Codex keeps its documented `gpt-5.6-luna` default. Mode and reasoning defaults are unchanged; they remain independent of model selection. With no model capability, the generic default object contains no model key.

The alternative of preserving last-item selection was rejected because ACP option order carries no preference or cost semantics. The change does not alter stored explicit choices or the main conversation's model.

The deterministic shared suite covers catalog order differing from the current model, absent model capability, generic provider behavior, and the builtin Codex exception. The CLI test also covers preserving a current Amp model and applying an explicit legacy model selection. The settings suite covers options appearing after capability testing, saves no inferred model, and still persists a model the user selects. The focused baseline replay fails because the result contains `model: "ultra"`; the same scenario passes after the change. Existing provider defaults and the Codex exception remain covered.

## Verification

- Shared: `vitest run packages/shared/tests/title-generation-defaults.test.ts` — 19 passed.
- CLI: `vitest run src/agent/title-generator.test.ts` — 10 passed.
- Settings: `vitest run tests/agent-config-dialog.test.tsx` — 52 passed.
- `pnpm format` and `pnpm run docs check` passed in an isolated worktree using Node 26.12.1 and the frozen lockfile.
- `pnpm check` reached the full CI test step after typecheck and lint passed, then failed in the unrelated existing `src/session/git-identity.test.ts` case `honors an explicit relative global override...` under local Apple Git 2.50.1; the focused title suites passed.
- Pull request: [#1909](https://github.com/LodyAI/Lody/pull/1909), draft.

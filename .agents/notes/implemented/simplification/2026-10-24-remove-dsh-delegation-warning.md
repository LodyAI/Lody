# Remove the obsolete DSH delegation warning

Status: implemented
Translation: current

[中文](2026-10-24-remove-dsh-delegation-warning.zh.md)

## Abstract

The DeepSeek Harness model menus still warned that delegated agents might use the session creation model and cost more. The reported upstream fix makes this warning obsolete, so desktop and mobile now omit it. The shared warning component, translations, and dedicated story are removed; model selection and runtime dispatch retain their existing behavior. This change does not independently verify the upstream runtime fix.

## Decision and verification

Remove the warning rather than retain a dormant model-specific condition. Keep the DeepSeek menu stories as model-selection examples and update the existing rendered-menu tests to assert that both surfaces show the selected model without the old warning or discussion link. Remove the redundant default-model warning test and the nearby CSS-class-only sizing test.

This supersedes only the warning portion of the [shared cues styling note](2026-09-26-shared-cues-stylex.md); its other visual decisions remain applicable. Current run-config documentation no longer describes the old restriction.

The model-picker suite passes all 15 tests, including the desktop and mobile warning-removal cases. Formatting, scoped lint, translation-key validation, and documentation checks pass. No live desktop visual check was performed.

The full `pnpm check` passes typechecking and lint but encounters a failure in the unchanged CLI `github-git-transport.test.ts` recursive SSH submodule clone case.

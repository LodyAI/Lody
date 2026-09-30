# Promote Prompt Shortcuts out of developer beta

Status: implemented
Translation: current

[中文](2026-09-29-prompt-shortcuts-general-availability.zh.md)

## Abstract

Prompt Shortcuts required both Developer mode and an explicit Beta opt-in, hiding a usable feature from ordinary users. Remove that product gate from settings, discovery and runtime initialization, and remove both About switches and obsolete copy. Existing workspace and platform boundaries stay intact. Existing stored opt-in values are ignored without a storage migration.

## Decision and evidence

This supersedes the opt-in requirement in the [mobile Beta control decision](../bug-fix/2026-09-25-mobile-prompt-shortcuts-beta.md). Keeping an always-true feature atom would leave unnecessary indirection, so callers now use their existing readiness conditions directly. The [runtime lifecycle protections](../bug-fix/2026-09-25-prompt-shortcut-runtime-lifecycle.md) remain necessary and unchanged.

Intent is recorded in the [availability spec](../../../../specs/prompt-shortcuts-availability.md). Developer-mode tests check settings visibility with the retired preference disabled and remove the obsolete Beta-switch expectation. Provider tests retain readiness, workspace and platform replacement coverage. Native mobile interaction is not manually verified.

## Validation

The focused provider/settings suites pass (10 tests), as do changed-file lint, documentation checks and repository script tests. Web and mobile production builds complete with a larger Node heap. The full cloud build reaches Electron packaging but requires the absent `VITE_ELECTRON_UPDATE_URL` deployment setting. Native mobile interaction remains unverified.

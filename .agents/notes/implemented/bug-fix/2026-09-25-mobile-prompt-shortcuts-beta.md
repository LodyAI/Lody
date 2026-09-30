# Mobile Prompt Shortcuts beta control

Status: implemented
Translation: current

[中文](2026-09-25-mobile-prompt-shortcuts-beta.zh.md)

## Abstract

Mobile About settings exposed the Inbox beta opt-in but omitted the existing
Prompt Shortcuts opt-in. The mobile beta section now offers Prompt Shortcuts
when Developer mode is enabled. It uses the same stored choice and derived
feature gate as desktop, preserving the choice when Developer mode is disabled.

## Implementation and validation

`MobileAboutSettings` reuses the desktop translation keys and
`promptShortcutsBetaEnabledAtom`; no additional storage or feature gate is needed.
The existing developer-mode test suite covers visibility, toggling, disabling
Developer mode, and restoring the saved opt-in when it is enabled again.

Changed TypeScript files pass Oxlint and Oxfmt; translation and platform-boundary
checks pass. Tests and `pnpm check` could not run because this checkout lacks
installed dependencies. Root formatting also requires those dependencies.
Documentation and public-boundary checks encounter missing ACP submodules.
Native mobile interaction has not been manually verified.

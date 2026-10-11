# DimCode mobile permission picker collision

Status: implemented
Translation: current
PR: [#1358](https://github.com/LodyAI/Lody/pull/1358)

[中文](2026-10-09-dimcode-mobile-permission-picker.zh.md)

## Abstract

DimCode permission changes can be lost before a new conversation is sent because
two mobile pickers share one coordinator ID. Pressing an option closes both
lists; if the option disappears before release, the selection callback never
runs. A synthetic fixture using DimCode's reported schema reproduced this in
Chromium touch input, and isolating generic picker IDs removed the premature
close. The fix gives provider-defined pickers an independent ID namespace. It preserves
all existing mode/config callbacks; packaged-device verification remains outstanding.

## Evidence

Source inspected at `26336e4a2`; Lody's agent catalog reports DimCode modes
`agent` / `goal` and a select with ID/category `permission`, offering
`read-only`, `workspace-write`, and `full-access`.

- `src/lib/acp-selector-order.ts` in `packages/components` recognizes explicit
  permissions only by ID `permission_mode` or category `_permission`. DimCode's
  permission select falls into `otherSelectors`.
- `mobile-run-config-sheet.tsx` renders that extra select with
  `run-config-${selector.configId}`, producing `run-config-permission`. Its
  legacy mode row uses the same ID and is also labelled Permission, despite
  containing Agent/Goal.
- `mobile-inline-picker.tsx` opens pickers by shared `activeId`. Both therefore
  open together. Its document capture `pointerdown` handler treats a press inside
  the other picker's panel as outside and clears `activeId`. Selection occurs
  later on click; the 0.2-second exit transition can remove the target first.

The isolated UI mounted the real `MobileNewChatSheet`, `MobileSessionRunConfig`,
and component-local selection hooks, with synthetic state matching this schema.
In a 393 × 852 Chromium touch viewport, the option was first checked for stable
actionability. Touch-down demonstrably targeted Full Access, closed the picker,
and removed the options; touch-up then left `permission=workspace-write`.
With only the generic ID changed temporarily to
`run-config-option:${selector.configId}`, just the intended list opened,
touch-down left it expanded, and release selected `full-access`.
The ID isolation is now retained in product code. Temporary browser fixtures were removed.

Fast automated taps succeeded in Chromium and WebKit. Consequently this evidence
establishes premature dismissal and a lost-selection path, not that every tap
fails, nor that the reporting device has the identical build. Dependencies were
reused from another local checkout; this was not a clean install, packaged
native-device test, full type check, or build.

## Correction and builtin audit

Provider config pickers now use `run-config-option:${selector.configId}` while
reserved rows retain their own IDs. No permission policy, payload, selection
lifetime, or Spec intent changes. Shared new-chat and existing-session composers
receive the same fix.

The catalog audit found the collision in DimCode. Reported Claude, Codex,
DeepSeek Harness and Devin use the legacy `mode` path; Kimi and Grok use
`permission_mode` / `_permission`. Older reported Kimi mode selectors and Grok
interaction selectors also avoid this collision. Pi reports no permission picker.
Bub has neither a runtime report available for this audit nor a static permission
schema; its user-installed ACP server needs runtime verification. The namespace
fix covers arbitrary provider IDs regardless of agent identity.

The owning sheet suite was renamed from `mobile-run-config-role-row.test.tsx` to
`mobile-run-config-sheet.test.tsx` and extended with real new-chat components and
local selection hooks. It tests seven builtin permission schemas (static schemas
for Claude/Codex/Kimi/Grok/DeepSeek, synthetic runtime schemas for DimCode/Devin),
Pi's absence of permission controls, and six synthetic collisions with reserved
permission/agent/role/model/interaction/reasoning rows. It asserts the picker stays
open after pointer-down, the selected state and label update after release, and
reopening preserves the choice. DimCode's independent Agent mode stays unchanged.
Seven cases failed before the fix; the sheet, selection, selector-options and
desktop-permission suites pass 100 tests after it. Role callback-only cases were
replaced with observable select/clear behavior.

Recognizing category `permission` globally is deferred: simply putting it in the
explicit-permission bucket hides DimCode's independent Agent/Goal entry. Existing
category/display behavior is preserved here; the mislabelled legacy mode row is
an unresolved display issue, separate from the repaired lost selection. See
[run-config ownership](../../../docs/sessions-run-config.md).

Earlier investigation found an unrelated existing-session readiness mismatch:
controls can be enabled while a scoped draft lacks an edit lease. New-chat uses
local selection without that gate; do not attribute this report to the
[draft retention change](../../implemented/bug-fix/2026-10-07-session-run-config-drafts.md).

Validation limits: targeted Oxfmt and Oxlint pass. Component typechecking is
blocked by missing checkout dependencies (including Electron) and unresolved
workspace imports; no full build/check is claimed. `docs check` retains the
baseline 70 errors and 65 warnings, with none of its errors on changed files.

PR preparation also attempted root `pnpm check` and `pnpm format`; both stop
because this nested checkout has no installed workspace toolchain (`tsgo` /
`oxfmt`). Targeted validation above used temporary links to an existing install.

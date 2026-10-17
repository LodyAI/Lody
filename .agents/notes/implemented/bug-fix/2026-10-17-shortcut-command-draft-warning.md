# Prompt Shortcut command field reports validity instead of enforcing it

Status: implemented
Translation: current

[中文](2026-10-17-shortcut-command-draft-warning.zh.md)

## Abstract

The Prompt Shortcut editor's slash-command field ran `slugify` on every
keystroke, which deleted characters a valid command needs mid-token — typing
`a-b` was impossible because the `-` was stripped the moment it appeared. The
field now keeps the raw draft and reports validity instead of enforcing it: an
invalid command wears `aria-invalid` and a floating warning anchored above the
field, which stays up after blur until the draft is fixed. Save-time validation
through `parsePromptShortcut` is unchanged, so an invalid command still cannot
be persisted.

## Decision

Per-keystroke sanitization conflates "not finished typing" with "invalid": every
legal command passes through states like `a-` that a normalizer must rewrite.
Validity is now derived (`SLUG_PATTERN` plus the length `maxLength` caps), never
applied to the draft, so a valid draft is already the form value when focus
leaves and an invalid one needs no reset. The warning is a controlled
`Popover` anchored to the field with `initialFocus`/`finalFocus` off, gated on
`slugTouched` so a fresh editor whose untouched command still follows the name
does not flash a warning. A rejected save marks the slug touched so the warning
and the save-error message agree.

The input's `pattern` attribute was removed with the sanitizer: a mismatched
draft is normal now, and the native constraint-validation bubble would block
submission ahead of the schema's own error message. `required` stays — an empty
command still gets the same native treatment as the name field.

A sweep of `packages/components` change handlers found no other field with this
defect. The workspace-handle inputs (`useWorkspaceSlugField`, the onboarding
workspace screen) already report rather than reject: `normalizeWorkspaceSlugInput`
deliberately preserves a trailing `-` and leaves invalid characters in the draft
for the inline `Field.Error`, stripping only sequences a valid handle can never
contain (leading `-`, `--`, uppercase). The session/machine rename fields replace
`\r\n`, which a single-line input cannot produce; `normalizeAgentRoleDescription`
only truncates.

## Verification

`tests/prompt-shortcut-form.test.tsx` covers the three behaviors: `a-b` retains
its dash with no warning, `bad slug` keeps its text and warning through blur,
and an untouched new editor derives `my-command` from the name without warning.
The `InvalidCommandWarning` Storybook story replays the invalid state;
Playwright-verified screenshots show the warning floating over the field in both
locales. Typecheck, oxlint, oxfmt and `lint:i18n` pass.

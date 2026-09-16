# Recover unavailable DSH default presets

Status: implemented
Translation: current

[中文](2026-09-16-dsh-default-preset-recovery.zh.md)

## Abstract

A Harness settings default can name a preset absent from Lody's packaged roster,
causing ACP session creation to fail before a prompt. The adapter now preserves
usable defaults and recovers unavailable ones to usable `standard`, reporting the
actual selection and logging a warning. It does not mutate settings or pick an
arbitrary composition. An unusable standard preset still requires repair; this
change does not promise recovery from a damaged runtime installation.

## Decision and evidence

This extends the [settings-provider integration](2026-09-08-dsh-settings-provider.md).
Harness 0.1.5-rc.2 reads the settings default before its composition default; the
adapter previously rejected a missing `code` at `session/new`. The reported
machine's configuration was not available, so its exact source of `code` remains
unconfirmed. Synthetic settings reproduce the configuration failure mechanism.

Recovery belongs in the provider adapter, which has the actual usable roster.
It occurs before creating the Agent and mounting MCP servers. The chosen preset
is passed to Agent metadata and mounting and returned in ACP config options.
Valid custom defaults and explicit selection validation retain their semantics.
Permission configuration is unchanged. Rewriting the user's settings would affect
other Harness profiles; choosing the first roster entry could select an unrelated
custom composition. Both alternatives were rejected.

## Validation and limits

The extension build and all 25 unit tests pass. Six real Harness settings smoke
cases pass, including `default: code` recovery on initial and subsequent session
creation, preservation of an available `minimal` default, explicit invalid preset
rejection, and unchanged settings bytes. Unit cases also cover broken defaults,
valid custom defaults, and missing/broken recovery targets before Agent creation.
The smoke launcher invokes `runCli()` explicitly to match the host on Node releases
without `import.meta.main`. No model requests or real user sessions are used.

The [settings Spec](../../../../specs/deepseek-harness-settings.md) remains draft.
The host pins DSH commit `feb3afe`, published in
[DSH PR #20](https://github.com/LodyAI/acp-extension-dsh/pull/20).
Merge that adapter change before the host integration; neither PR deploys a running client.
Host integration: [Lody PR #748](https://github.com/LodyAI/Lody/pull/748).
The root checkout lacks workspace dependencies and other submodules, limiting
root checks; no desktop release has been built or installed.
Root `pnpm check` stops at missing `tsgo`, `pnpm format` at missing `oxfmt`,
and docs validation reports links into uninitialized submodules. The submodule's
default Prettier check also rejects the unchanged baseline formatting; unrelated
formatting was preserved. Both repository diffs pass whitespace checks.
